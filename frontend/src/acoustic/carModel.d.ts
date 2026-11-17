import type * as THREE from 'three';

export interface CarSpec { L: number; W: number; wheelR: number }

export interface CarModel {
  group: THREE.Group;
  spec: CarSpec;
  body: THREE.Mesh;
  lights: { drl?: THREE.MeshBasicMaterial; head: THREE.MeshBasicMaterial; tail: THREE.MeshBasicMaterial };
  setRoll(distance: number): void;
  setOutline(k: number): void;
  setLights(k: number): void;
  updateFlares(camera: THREE.Camera, gain?: number): void;
}

export function buildCar(opts?: { paint?: number | string }): CarModel;
