#!/usr/bin/env python3
"""Print comparable topology, geometry, rig, and animation facts for arm assets."""

from pathlib import Path
import hashlib
import struct

import bpy
from mathutils.kdtree import KDTree


ROOT = Path(__file__).resolve().parents[1]
ASSETS = (
    ROOT / "assets" / "player" / "Aletheia_Chrome_1p_arms.glb",
    ROOT / "assets" / "player" / "First_Person_Aletheia_Arms_Hands.glb",
    ROOT / "assets" / "player" / "runtime" / "First_Person_Aletheia_Arms_Hands_viewmodel.glb",
    ROOT / "assets" / "player" / "runtime" / "Aletheia_Chrome_1p_arms_viewmodel.glb",
)


def digest_mesh(mesh) -> tuple[str, str]:
    positions = hashlib.sha256()
    topology = hashlib.sha256()
    for vertex in mesh.data.vertices:
        positions.update(struct.pack("<3d", *vertex.co))
    for polygon in mesh.data.polygons:
        topology.update(struct.pack("<I", len(polygon.vertices)))
        for index in polygon.vertices:
            topology.update(struct.pack("<I", index))
    return positions.hexdigest()[:16], topology.hexdigest()[:16]


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.armatures, bpy.data.actions):
        for datablock in list(datablocks):
            datablocks.remove(datablock)


def main() -> None:
    for path in ASSETS:
        reset_scene()
        bpy.ops.import_scene.gltf(filepath=str(path))
        meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
        print("ARM_ASSET", path.relative_to(ROOT))
        for mesh in meshes:
            position_hash, topology_hash = digest_mesh(mesh)
            bounds = [mesh.matrix_world @ vertex.co for vertex in mesh.data.vertices]
            minimum = tuple(round(min(point[axis] for point in bounds), 6) for axis in range(3))
            maximum = tuple(round(max(point[axis] for point in bounds), 6) for axis in range(3))
            print(
                "  MESH",
                mesh.name,
                "verts", len(mesh.data.vertices),
                "edges", len(mesh.data.edges),
                "polys", len(mesh.data.polygons),
                "groups", len(mesh.vertex_groups),
                "uv", len(mesh.data.uv_layers),
                "bounds", minimum, maximum,
                "positionHash", position_hash,
                "topologyHash", topology_hash,
            )
        for armature in armatures:
            print(
                "  ARMATURE", armature.name,
                "bones", len(armature.data.bones),
                "names", tuple(bone.name for bone in armature.data.bones),
            )
            surface = max(meshes, key=lambda item: len(item.data.vertices))
            tree = KDTree(len(surface.data.vertices))
            for vertex in surface.data.vertices:
                tree.insert(surface.matrix_world @ vertex.co, vertex.index)
            tree.balance()
            for bone in armature.data.bones:
                if not bone.name.startswith("right_") or bone.name in {
                    "right_upper_arm", "right_forearm"
                }:
                    continue
                head = armature.matrix_world @ bone.head_local
                tail = armature.matrix_world @ bone.tail_local
                head_distance = tree.find(head)[2]
                tail_distance = tree.find(tail)[2]
                print(
                    "    BONE", bone.name,
                    "head", tuple(round(value, 5) for value in head),
                    "tail", tuple(round(value, 5) for value in tail),
                    "surfaceDistance", round(head_distance, 5), round(tail_distance, 5),
                )
        print("  ACTIONS", tuple(sorted(action.name for action in bpy.data.actions)))


if __name__ == "__main__":
    main()
