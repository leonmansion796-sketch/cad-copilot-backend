#!/usr/bin/env python3
"""
hollow_stl.py — proper STL hollowing using trimesh
Called by server.js as a child process:
  python3 hollow_stl.py <wall_thickness_mm>
  STL base64 passed via stdin, hollowed STL base64 returned via stdout
"""

import sys
import base64
import io
import json
import traceback

def hollow_mesh(stl_bytes, wall_mm):
    import trimesh
    import numpy as np

    # Load mesh
    mesh = trimesh.load(io.BytesIO(stl_bytes), file_type='stl', force='mesh')

    if not isinstance(mesh, trimesh.Trimesh):
        raise ValueError("Could not load as single mesh")

    # Fix mesh issues
    trimesh.repair.fix_normals(mesh)
    trimesh.repair.fix_winding(mesh)

    # Check mesh is watertight enough to work with
    # If not, just try anyway
    
    # Get bounding box
    bounds = mesh.bounds
    extents = mesh.extents  # [x_size, y_size, z_size]
    min_extent = min(extents)

    # Cap wall thickness to 40% of smallest dimension
    wall_mm = min(wall_mm, min_extent * 0.4)
    if wall_mm < 0.1:
        wall_mm = 0.1

    # Create inner shell by:
    # 1. Copy the mesh
    # 2. Scale it slightly smaller
    # 3. Flip its normals (invert)
    # 4. Combine with original

    inner = mesh.copy()

    # Scale toward centroid
    center = mesh.centroid
    scale_factors = np.array([
        max(0.05, (extents[0] - wall_mm * 2) / extents[0]) if extents[0] > 0 else 1,
        max(0.05, (extents[1] - wall_mm * 2) / extents[1]) if extents[1] > 0 else 1,
        max(0.05, (extents[2] - wall_mm * 2) / extents[2]) if extents[2] > 0 else 1,
    ])

    # Apply non-uniform scaling toward centroid
    inner.vertices = center + (inner.vertices - center) * scale_factors

    # Flip normals for inner shell (faces point inward)
    inner.invert()

    # Combine outer + inner shell
    hollow = trimesh.util.concatenate([mesh, inner])

    # Export to STL bytes
    out = io.BytesIO()
    hollow.export(out, file_type='stl')
    return out.getvalue()


def main():
    try:
        wall_mm = float(sys.argv[1]) if len(sys.argv) > 1 else 2.0

        # Read base64 STL from stdin
        b64 = sys.stdin.read().strip()
        stl_bytes = base64.b64decode(b64)

        # Hollow it
        result_bytes = hollow_mesh(stl_bytes, wall_mm)

        # Return base64 to stdout
        result_b64 = base64.b64encode(result_bytes).decode('ascii')
        print(json.dumps({"success": True, "stlBase64": result_b64}))

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e), "trace": traceback.format_exc()}))
        sys.exit(1)


if __name__ == "__main__":
    main()
