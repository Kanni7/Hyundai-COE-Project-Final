import json

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from bhashadrive.config import NavConfig
from bhashadrive.nav.routes import RouteService, nav_router

ORIGIN = {"lat": 19.076, "lng": 72.8777}


def _client(handler, key="k"):
    cfg = NavConfig(google_maps_api_key=key, fuel_price_inr_per_l=100.0, mileage_kmpl=20.0)
    app = FastAPI()
    app.include_router(nav_router(RouteService(cfg, httpx.Client(transport=httpx.MockTransport(handler)))))
    return TestClient(app)


def test_route_facts_from_google_and_fuel_arithmetic():
    sent = {}

    def handler(req):
        sent["body"], sent["headers"] = json.loads(req.content), req.headers
        return httpx.Response(200, json={"routes": [{"distanceMeters": 148250, "duration": "10830s", "travelAdvisory": {
            "tollInfo": {"estimatedPrice": [{"currencyCode": "INR", "units": "320", "nanos": 500000000}]}}}]})

    r = _client(handler).post("/nav/route", json={"origin": ORIGIN, "destination": " Pune "}).json()
    assert sent["body"]["destination"] == {"address": "Pune"} and "TOLLS" in sent["body"]["extraComputations"]
    assert sent["headers"]["x-goog-api-key"] == "k" and "tollInfo" in sent["headers"]["x-goog-fieldmask"]
    assert r["km"] == 148.2 and r["minutes"] == 180 and r["toll"] == {"inr": 320.5}
    assert r["fuel_litres"] == 7.4 and r["fuel_inr"] == 741  # 148.25 km / 20 kmpl x Rs 100


def test_toll_absent_vs_unknown_price():
    no_toll = _client(lambda q: httpx.Response(200, json={"routes": [{"distanceMeters": 5000, "duration": "600s"}]}))
    assert no_toll.post("/nav/route", json={"origin": ORIGIN, "destination": "Juhu"}).json()["toll"] is None
    unknown = _client(lambda q: httpx.Response(200, json={"routes": [{"distanceMeters": 5000, "duration": "600s",
                                                                       "travelAdvisory": {"tollInfo": {}}}]}))
    assert unknown.post("/nav/route", json={"origin": ORIGIN, "destination": "Juhu"}).json()["toll"] == {"inr": None}


def test_errors_never_invent_a_route():
    assert _client(None, key=None).post("/nav/route", json={"origin": ORIGIN, "destination": "Pune"}).status_code == 503
    assert _client(lambda q: httpx.Response(200, json={})).post("/nav/route", json={"origin": ORIGIN, "destination": "Nowhere"}).status_code == 404
    bad_key = _client(lambda q: httpx.Response(403, json={"error": {"message": "API key not valid"}}))
    r = bad_key.post("/nav/route", json={"origin": ORIGIN, "destination": "Pune"})
    assert r.status_code == 502 and "API key not valid" in r.json()["detail"]["message"]
    assert _client(None).post("/nav/route", json={"origin": {"lat": 200, "lng": 0}, "destination": "Pune"}).status_code == 422
