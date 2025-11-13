/**
 * PerformanceManager - Handles GPU/CPU performance tracking, benchmarking, and monitoring
 * 
 * Responsibilities:
 * - Track GPU and CPU processing statistics
 * - Toggle between GPU and CPU coordinate processing
 * - Run performance benchmarks
 * - Provide live performance monitoring
 */

export class PerformanceManager {
    constructor() {
        this.stats = {
            gpuEnabled: true,
            totalCoordinatesProcessed: 0,
            totalGPUTime: 0,
            totalCPUTime: 0,
            batchCount: 0,
            gpuBatchCount: 0,
            cpuFeatureCount: 0,
            averageGPUBatchSize: 0,
            averageCPUTime: 0,
            lastSpeedupRatio: 0,
            coordinatesPerSecondGPU: 0,
            coordinatesPerSecondCPU: 0
        };
        
        this.monitorInterval = null;
    }
    
    /**
     * Enable or disable GPU processing
     */
    setGPUEnabled(enabled) {
        this.stats.gpuEnabled = enabled;
        return enabled;
    }
    
    /**
     * Check if GPU processing is enabled
     */
    isGPUEnabled() {
        return this.stats.gpuEnabled;
    }
    
    /**
     * Get current statistics with derived values
     */
    getStats() {
        const stats = { ...this.stats };
        
        // Calculate derived statistics
        if (stats.totalGPUTime > 0 && stats.gpuBatchCount > 0) {
            stats.averageGPUBatchTime = stats.totalGPUTime / stats.gpuBatchCount;
            stats.coordinatesPerSecondGPU = (stats.totalCoordinatesProcessed / stats.totalGPUTime) * 1000;
        }
        
        if (stats.totalCPUTime > 0 && stats.cpuFeatureCount > 0) {
            stats.averageCPUTime = stats.totalCPUTime / stats.cpuFeatureCount;
            stats.coordinatesPerSecondCPU = (stats.totalCoordinatesProcessed / stats.totalCPUTime) * 1000;
        }
        
        if (stats.totalGPUTime > 0 && stats.totalCPUTime > 0) {
            stats.lastSpeedupRatio = stats.totalCPUTime / stats.totalGPUTime;
        }
        
        return stats;
    }
    
    /**
     * Reset all statistics
     */
    resetStats() {
        Object.keys(this.stats).forEach(key => {
            if (typeof this.stats[key] === 'number') {
                this.stats[key] = 0;
            }
        });
        this.stats.gpuEnabled = true;
    }
    
    /**
     * Log formatted performance statistics
     */
    logStats() {
        const stats = this.stats;
        
        if (stats.gpuEnabled && stats.totalGPUTime > 0) {
            const avgGPUTime = stats.totalGPUTime / stats.batchCount;
            const coordsPerSecond = (stats.totalCoordinatesProcessed / stats.totalGPUTime) * 1000;
            
            console.log(`🚀 GPU Performance Stats:`);
            console.log(`  Total coordinates: ${stats.totalCoordinatesProcessed.toLocaleString()}`);
            console.log(`  Total GPU time: ${stats.totalGPUTime.toFixed(2)}ms`);
            console.log(`  Average batch time: ${avgGPUTime.toFixed(2)}ms`);
            console.log(`  Coordinates/second: ${coordsPerSecond.toFixed(0)}`);
        }
        
        if (stats.totalCPUTime > 0) {
            const coordsPerSecond = (stats.totalCoordinatesProcessed / stats.totalCPUTime) * 1000;
            
            console.log(`💻 CPU Performance Stats:`);
            console.log(`  Total coordinates: ${stats.totalCoordinatesProcessed.toLocaleString()}`);
            console.log(`  Total CPU time: ${stats.totalCPUTime.toFixed(2)}ms`);
            console.log(`  Coordinates/second: ${coordsPerSecond.toFixed(0)}`);
        }
        
        if (stats.totalGPUTime > 0 && stats.totalCPUTime > 0) {
            const speedup = stats.totalCPUTime / stats.totalGPUTime;
            console.log(`⚡ GPU Speedup: ${speedup.toFixed(1)}x faster than CPU`);
        }
    }
    
    /**
     * Run performance benchmark comparing GPU vs CPU
     */
    async runBenchmark(device, coordinates = 1000) {
        if (!device) {
            console.error('WebGPU device not available for benchmark');
            return null;
        }
        
        // Generate test coordinates
        const testCoords = [];
        for (let i = 0; i < coordinates; i++) {
            testCoords.push([
                Math.random() * 360 - 180, // longitude
                Math.random() * 170 - 85   // latitude
            ]);
        }
        
        // GPU benchmark
        const gpuStartTime = performance.now();
        const { gpuMercatorToClipSpace } = await import('./coordinateGPU.js');
        const gpuResults = await gpuMercatorToClipSpace(testCoords, device);
        const gpuTime = performance.now() - gpuStartTime;
        
        // CPU benchmark
        const cpuStartTime = performance.now();
        const { mercatorToClipSpace } = await import('./utils.js');
        const cpuResults = testCoords.map(coord => mercatorToClipSpace(coord[0], coord[1]));
        const cpuTime = performance.now() - cpuStartTime;
        
        // Calculate metrics
        const speedup = cpuTime / gpuTime;
        const gpuThroughput = (coordinates / gpuTime) * 1000;
        const cpuThroughput = (coordinates / cpuTime) * 1000;
        
        // Verify results match
        let errorCount = 0;
        for (let i = 0; i < Math.min(10, coordinates); i++) {
            const gpuCoord = gpuResults[i];
            const cpuCoord = cpuResults[i];
            const diffX = Math.abs(gpuCoord[0] - cpuCoord[0]);
            const diffY = Math.abs(gpuCoord[1] - cpuCoord[1]);
            
            if (diffX > 1e-5 || diffY > 1e-5) {
                errorCount++;
            }
        }
        
        return {
            coordinates,
            gpuTime,
            cpuTime,
            speedup,
            gpuThroughput,
            cpuThroughput,
            errorCount
        };
    }
    
    /**
     * Enable live performance monitoring
     */
    enableLiveMonitoring(intervalMs = 5000) {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
        }
        
        this.monitorInterval = setInterval(() => {
            const stats = this.getStats();
            if (stats.totalCoordinatesProcessed > 0) {
                console.log(`📈 Live Stats: ${stats.totalCoordinatesProcessed.toLocaleString()} coords processed, ` +
                          `${stats.gpuEnabled ? 'GPU' : 'CPU'} mode, ` +
                          `${stats.lastSpeedupRatio ? stats.lastSpeedupRatio.toFixed(1) + 'x speedup' : 'no comparison'}`);
            }
        }, intervalMs);
    }
    
    /**
     * Disable live monitoring
     */
    disableLiveMonitoring() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
    }
}
