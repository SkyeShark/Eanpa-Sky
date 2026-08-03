"""Render deterministic workbench review views of the authored ziggurat Blend."""

import os
import sys

import bpy
from mathutils import Vector


def point_camera(camera, eye, target, ortho_scale=None):
    camera.location = eye
    camera.rotation_euler = (Vector(target) - Vector(eye)).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type = 'ORTHO' if ortho_scale is not None else 'PERSP'
    if ortho_scale is not None:
        camera.data.ortho_scale = ortho_scale
    else:
        camera.data.lens = 28


def main(output_dir):
    os.makedirs(output_dir, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_x = 1000
    scene.render.resolution_y = 760
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.studio_light = 'paint.sl'
    scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    if hasattr(scene.display.shading, 'show_backface_culling'):
        scene.display.shading.show_backface_culling = True
    scene.display.shading.cavity_type = 'BOTH'
    scene.display.shading.curvature_ridge_factor = 1.35
    scene.display.shading.curvature_valley_factor = 1.15
    scene.display.shading.background_type = 'VIEWPORT'
    scene.display.shading.background_color = (0.025, 0.035, 0.05)
    scene.render.film_transparent = False
    for material in bpy.data.materials:
        if hasattr(material, 'use_backface_culling'):
            material.use_backface_culling = True

    camera_data = bpy.data.cameras.new('architecture_review_camera')
    camera = bpy.data.objects.new('architecture_review_camera', camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera

    views = {
        'front': ((0, -86, 12), (0, 0, 10.0), 76),
        'side': ((92, -6, 15), (0, -6, 10.0), 88),
        'three_quarter': ((67, -78, 43), (0, -4, 9.0), 84),
        'stairs': ((24, -56, 18), (0, -16, 9.0), 55),
        'ground_approach_backface_culled': ((0, -46, 2.2), (0, -23, 8.0), None),
    }
    for name, (eye, target, scale) in views.items():
        point_camera(camera, eye, target, scale)
        scene.render.filepath = os.path.join(output_dir, f'ziggurat_review_{name}.png')
        bpy.ops.render.render(write_still=True)
        print('Rendered', scene.render.filepath)


if __name__ == '__main__':
    args = sys.argv
    output = args[args.index('--') + 1] if '--' in args and len(args) > args.index('--') + 1 else os.getcwd()
    main(os.path.abspath(output))
