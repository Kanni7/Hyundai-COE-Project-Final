"""Route facts for the cockpit's navigation questions ("kitna time lagega", "toll kitna hai", "how far"):
Google Routes API computeRoutes from the car's position to a destination named in words.

Numbers come only from the routing service or from arithmetic on them (fuel cost = km / mileage x price);
nothing is estimated by a language model. Toll prices are Google's cash estimate where it has one; a route
with tolls but no known price says so instead of guessing.
"""
from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..assistant.providers import IPv4First
from ..config import NavConfig

URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
FIELDS = "routes.duration,routes.distanceMeters,routes.travelAdvisory.tollInfo"


class LatLng(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class RouteIn(BaseModel):
    origin: LatLng
    destination: str = Field(min_length=1, max_length=100)


class RouteService:
    def __init__(self, config: NavConfig, client: httpx.Client | None = None):
        self.config = config
        self.client = client or httpx.Client(transport=IPv4First())

    def route(self, origin: LatLng, destination: str) -> dict:
        c = self.config
        if not c.google_maps_api_key:
            raise HTTPException(503, {"code": "not_configured", "message": "GOOGLE_MAPS_API_KEY is not set."})
        body = {
            "origin": {"location": {"latLng": {"latitude": origin.lat, "longitude": origin.lng}}},
            "destination": {"address": destination},
            "travelMode": "DRIVE",
            "routingPreference": "TRAFFIC_AWARE",
            "extraComputations": ["TOLLS"],
            "routeModifiers": {"vehicleInfo": {"emissionType": "GASOLINE"}},
            "regionCode": "in",
            "languageCode": "en-IN",
            "units": "METRIC",
        }
        try:
            r = self.client.post(URL, json=body, timeout=c.timeout_s,
                                 headers={"X-Goog-Api-Key": c.google_maps_api_key, "X-Goog-FieldMask": FIELDS})
        except httpx.TimeoutException:
            raise HTTPException(504, {"code": "timeout", "message": "The maps service did not answer in time."})
        except httpx.HTTPError:
            raise HTTPException(502, {"code": "network", "message": "The maps service is not reachable."})
        if r.status_code != 200:
            # The key never appears here: only Google's status and the first part of its message.
            msg = (r.json().get("error", {}).get("message", "") if r.headers.get("content-type", "").startswith("application/json") else "")[:200]
            raise HTTPException(502, {"code": "maps_error", "message": f"Maps service error {r.status_code}. {msg}".strip()})
        routes = r.json().get("routes") or []
        if not routes:  # Google's answer when the address is not found or no road route exists
            raise HTTPException(404, {"code": "no_route", "message": f"No driving route found to {destination}."})
        return summarize(routes[0], destination, c)


def summarize(route: dict, destination: str, c: NavConfig) -> dict:
    km = route.get("distanceMeters", 0) / 1000
    minutes = round(float(str(route.get("duration", "0s")).rstrip("s") or 0) / 60)
    info = (route.get("travelAdvisory") or {}).get("tollInfo")
    toll = None  # no tollInfo: Google knows of no toll on the route
    if info is not None:
        inr = [p for p in info.get("estimatedPrice") or [] if p.get("currencyCode") == "INR"]
        toll = {"inr": round(sum(int(p.get("units", 0)) + p.get("nanos", 0) / 1e9 for p in inr), 2) if inr else None}
    litres = km / c.mileage_kmpl
    return {"destination": destination, "km": round(km, 1), "minutes": minutes, "toll": toll,
            "fuel_litres": round(litres, 1), "fuel_inr": round(litres * c.fuel_price_inr_per_l),
            "fuel_price_inr_per_l": c.fuel_price_inr_per_l, "mileage_kmpl": c.mileage_kmpl}


def nav_router(service: RouteService) -> APIRouter:
    r = APIRouter(prefix="/nav")

    @r.post("/route")
    def route(body: RouteIn):
        return service.route(body.origin, body.destination.strip())

    @r.get("/status")
    def status():
        return {"configured": bool(service.config.google_maps_api_key)}

    return r
