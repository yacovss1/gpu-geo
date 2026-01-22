/**
 * Terrain Module - GPU-based terrain projection for all geometry types
 * 
 * Exports:
 * - TerrainComputePipeline: Core compute pipeline for adaptive tessellation and draping
 * - TerrainComputeManager: Integration layer for tile and render system
 * - createTerrainComputeManager: Factory function for manager creation
 */

export { TerrainComputePipeline } from './terrainComputePipeline.js';
export { TerrainComputeManager, createTerrainComputeManager } from './terrainComputeIntegration.js';
