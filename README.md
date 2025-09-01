
# Camera Frustums Viewer

This is a web app for visualizing camera poses in 3D, designed for Blender-style camera conventions and compatible with the [D-NeRF](https://github.com/albertpumarola/D-NeRF) dataset format. It renders camera frustums from a `transforms.json` file and provides interactive controls for exploring camera arrangements.

## Features

- Visualizes camera frustums (truncated pyramids) in 3D using Three.js and React Three Fiber
- Supports drag-and-drop or file upload of D-NeRF-style JSON files
- Interactive orbit, pan, zoom, and fit-to-view controls
- Toggle grid, axes, labels, and diagnostics
- Supports Blender (Z-up) and Three.js (Y-up) conventions
- Option to invert matrices if your dataset uses world-to-camera transforms

## Input Format

Pass a JSON file (typically named `transforms.json`) with the following structure:

```json
{
	"camera_angle_x": 0.7,
	"frames": [
		{ "file_path": "./img_000", "transform_matrix": [[...],[...],[...],[...]] },
		...
	]
}
```
- `camera_angle_x`: Horizontal field of view in radians
- `frames`: Array of camera objects, each with a `transform_matrix` (4x4, row-major, camera-to-world)

## Setup

1. **Install dependencies:**
	 ```sh
	 npm install
	 ```
2. **Start the development server:**
	 ```sh
	 npm run dev
	 ```
3. Open [http://localhost:5173](http://localhost:5173) in your browser.

## Usage

1. Prepare your `transforms.json` file in the D-NeRF format.
2. Drag and drop the file onto the app, or use the "Load JSON" button.
3. Explore the camera poses in 3D. Use the controls to adjust aspect, near/far planes, scale, and visualization options.
4. If your transforms are world-to-camera, enable "Invert matrices".
5. Switch between Blender (Z-up) and Three.js (Y-up) world conventions as needed.

## Example

Sample input:
```json
{
	"camera_angle_x": 0.7,
	"frames": [
		{ "file_path": "img_000", "transform_matrix": [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]] },
		{ "file_path": "img_001", "transform_matrix": [[1,0,0,2],[0,1,0,1],[0,0,1,2],[0,0,0,1]] }
	]
}
```

## Build & Preview

- **Build for production:**
	```sh
	npm run build
	```
- **Preview production build:**
	```sh
	npm run preview
	```

