export class MarkerManager {
    constructor() {
        this.markers = [];
        this.transformMatrix = null;
        this.debugInfo = true; // Set to true to show positioning debug info
        this.markerStyle = {
            size: 5,
            color: '#ff0000',
            strokeColor: '#ffffff',
            strokeWidth: 2
        };
    }
    
    addMarker(position, countryName, color = null) {
        // Skip adding if a marker with this country name already exists.
        if (this.markers.some(m => m.countryName === countryName)) {
            return;
        }
        // Store the country name along with the position (assumed to be clip space)
        this.markers.push({ 
            position, 
            countryName,
            color: color || this.markerStyle.color,
            size: this.markerStyle.size
        });
    }
    
    clearMarkers() {
        this.markers = [];
    }
    
    // Store the WebGPU transform matrix for exact matching
    setTransformMatrix(matrix) {
        this.transformMatrix = matrix;
    }
    
    updateMarkers(camera) {
        // Get the camera transform matrix (typically computed with gl-matrix)
        const matrix = camera.getMatrix(); // 4x4 matrix
        for (const marker of this.markers) {
            if (!marker.position) continue;
            // marker.position is a vec2 in clip space.
            const pos = [marker.position[0], marker.position[1], 0, 1];
            const clip = multiplyMatrixAndVector(matrix, pos);
            // Perspective division in case clip.w != 1
            const ndc = [clip[0] / clip[3], clip[1] / clip[3]];
            // Convert NDC (-1..1) to screen coordinates
            const screenX = (ndc[0] + 1) * camera.viewportWidth / 2;
            // Use (1 - ndc[1]) to match the clip-to-screen transformation used in the center pipeline
            const screenY = (1 - ndc[1]) * camera.viewportHeight / 2;
            marker.screenPosition = [screenX, screenY];
        }
    }

    // Configure marker appearance
    setMarkerStyle(options = {}) {
        this.markerStyle = {
            size: options.size || this.markerStyle.size,
            color: options.color || this.markerStyle.color,
            strokeColor: options.strokeColor || this.markerStyle.strokeColor,
            strokeWidth: options.strokeWidth || this.markerStyle.strokeWidth
        };
    }

    // Return data for GPU buffer - do NOT transform here, GPU will handle it
    getMarkerBufferData() {
        const data = new Float32Array(this.markers.length * 6);
        
        // Don't use the MarkerManager's markers - they're duplicative
        // We'll keep this method for compatibility but not use its data
        
        for (let i = 0; i < this.markers.length; i++) {
            const m = this.markers[i];
            data[i*6 + 0] = m.position[0];  // x
            data[i*6 + 1] = m.position[1];  // y
            data[i*6 + 2] = 1.0;  // red
            data[i*6 + 3] = 0.0;  // green
            data[i*6 + 4] = 0.0;  // blue
            data[i*6 + 5] = 1.0;  // alpha
        }
        return data;
    }

    resizeCanvas(width, height) {
        // Stub method to avoid errors
        return false;
    }

    render() {
        // Stub method if markers are purely GPU-rendered
    }
}

function multiplyMatrixAndVector(matrix, vector) {
    // Assuming column-major order (as used by gl-matrix)
    const result = [];
    result[0] = matrix[0] * vector[0] + matrix[4] * vector[1] + matrix[8]  * vector[2] + matrix[12] * vector[3];
    result[1] = matrix[1] * vector[0] + matrix[5] * vector[1] + matrix[9]  * vector[2] + matrix[13] * vector[3];
    result[2] = matrix[2] * vector[0] + matrix[6] * vector[1] + matrix[10] * vector[2] + matrix[14] * vector[3];
    result[3] = matrix[3] * vector[0] + matrix[7] * vector[1] + matrix[11] * vector[2] + matrix[15] * vector[3];
    return result;
}
