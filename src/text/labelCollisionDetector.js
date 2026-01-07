// Label Collision Detection and 3D Offset Calculation
// Detects overlapping labels and assigns placement modes (DIRECT, OFFSET_3D, HIDDEN)

import { LabelMode } from './gpuTextRenderer.js';

/**
 * Simple spatial grid for efficient collision detection
 */
class SpatialGrid {
    constructor(cellSize = 0.1) {
        this.cellSize = cellSize;
        this.grid = new Map();
    }

    getCellKey(x, y) {
        const cx = Math.floor(x / this.cellSize);
        const cy = Math.floor(y / this.cellSize);
        return `${cx},${cy}`;
    }

    insert(bbox, labelIndex) {
        // Insert into all cells the bbox overlaps
        const minCellX = Math.floor(bbox.minX / this.cellSize);
        const maxCellX = Math.floor(bbox.maxX / this.cellSize);
        const minCellY = Math.floor(bbox.minY / this.cellSize);
        const maxCellY = Math.floor(bbox.maxY / this.cellSize);

        for (let cx = minCellX; cx <= maxCellX; cx++) {
            for (let cy = minCellY; cy <= maxCellY; cy++) {
                const key = `${cx},${cy}`;
                if (!this.grid.has(key)) {
                    this.grid.set(key, []);
                }
                this.grid.get(key).push(labelIndex);
            }
        }
    }

    query(bbox) {
        const candidates = new Set();
        const minCellX = Math.floor(bbox.minX / this.cellSize);
        const maxCellX = Math.floor(bbox.maxX / this.cellSize);
        const minCellY = Math.floor(bbox.minY / this.cellSize);
        const maxCellY = Math.floor(bbox.maxY / this.cellSize);

        for (let cx = minCellX; cx <= maxCellX; cx++) {
            for (let cy = minCellY; cy <= maxCellY; cy++) {
                const key = `${cx},${cy}`;
                const cell = this.grid.get(key);
                if (cell) {
                    cell.forEach(idx => candidates.add(idx));
                }
            }
        }

        return Array.from(candidates);
    }

    clear() {
        this.grid.clear();
    }
}

/**
 * Check if two bounding boxes overlap
 */
function bboxesOverlap(a, b) {
    return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

/**
 * Calculate bounding box for a label
 */
function calculateLabelBBox(position, textLength, charWidth = 0.024, charHeight = 0.04) {
    // Approximate label dimensions based on character count
    const labelWidth = textLength * charWidth * 2; // 2x for spacing
    const labelHeight = charHeight * 2;
    const labelOffset = 0.035; // Same as shader

    return {
        minX: position.x - labelWidth / 2,
        maxX: position.x + labelWidth / 2,
        minY: position.y + labelOffset - labelHeight / 2,
        maxY: position.y + labelOffset + labelHeight / 2
    };
}

/**
 * Label Collision Detector
 * Detects overlapping labels and assigns placement modes
 */
export class LabelCollisionDetector {
    constructor() {
        this.grid = new SpatialGrid(0.1);
        this.labels = [];
        this.bboxes = [];
    }

    /**
     * Process labels and detect collisions
     * @param {Array} labelData - Array of {featureId, text, position: {x, y, z}, sourceLayer, priority}
     * @param {Object} markerBuffer - GPU marker buffer data (for positions)
     * @returns {Array} - Updated labelData with mode, anchorPos, offsetVector fields
     */
    detectCollisions(labelData, markerPositions) {
        this.grid.clear();
        this.labels = [];
        this.bboxes = [];

        // Build bounding boxes and spatial index
        labelData.forEach((label, idx) => {
            const position = markerPositions.get(label.featureId);
            
            if (!position) {
                // No marker position yet - use DIRECT mode (shader will get position from marker buffer)
                this.labels.push({
                    ...label,
                    mode: LabelMode.DIRECT,
                    anchorPos: [0, 0, 0],
                    offsetVector: [0, 0, 0],
                    collisionGroup: []
                });
                return;
            }

            const bbox = calculateLabelBBox(position, label.text.length);
            this.bboxes.push(bbox);
            
            this.labels.push({
                ...label,
                position,
                bbox,
                mode: LabelMode.DIRECT, // Start with DIRECT
                anchorPos: [position.x, position.y, position.z || 0],
                offsetVector: [0, 0, 0],
                collisionGroup: []
            });

            this.grid.insert(bbox, idx);
        });

        // Detect collisions
        for (let i = 0; i < this.labels.length; i++) {
            const label = this.labels[i];
            if (label.mode === LabelMode.HIDDEN || !label.bbox) continue;

            const candidates = this.grid.query(label.bbox);
            
            for (const j of candidates) {
                if (i >= j) continue; // Skip self and already processed pairs
                
                const other = this.labels[j];
                if (other.mode === LabelMode.HIDDEN || !other.bbox) continue;

                if (bboxesOverlap(label.bbox, other.bbox)) {
                    // Collision detected! Add to collision groups
                    if (label.collisionGroup) label.collisionGroup.push(j);
                    if (other.collisionGroup) other.collisionGroup.push(i);
                }
            }
        }

        // Resolve collisions with priority system
        this.resolveCollisions();

        return this.labels.map(label => ({
            featureId: label.featureId,
            text: label.text,
            sourceLayer: label.sourceLayer,
            mode: label.mode,
            anchorPos: label.anchorPos,
            offsetVector: label.offsetVector
        }));
    }

    /**
     * Resolve collisions using priority and 3D offset strategy
     */
    resolveCollisions() {
        // Priority order: places > buildings > other
        const priorityOrder = {
            'place': 0,
            'building': 1,
            'landuse': 2,
            'water': 3,
            'default': 4
        };

        // Sort labels by priority
        const sortedIndices = this.labels
            .map((label, idx) => ({ label, idx }))
            .filter(item => item.label.mode !== LabelMode.HIDDEN)
            .sort((a, b) => {
                const priorityA = priorityOrder[a.label.sourceLayer] ?? priorityOrder.default;
                const priorityB = priorityOrder[b.label.sourceLayer] ?? priorityOrder.default;
                return priorityA - priorityB;
            })
            .map(item => item.idx);

        // Process in priority order
        const placed = new Set();
        
        for (const idx of sortedIndices) {
            const label = this.labels[idx];
            
            // Skip if no collision group (safety check)
            if (!label.collisionGroup) {
                label.mode = LabelMode.DIRECT;
                placed.add(idx);
                continue;
            }
            
            if (label.collisionGroup.length === 0) {
                // No collisions, place directly
                label.mode = LabelMode.DIRECT;
                placed.add(idx);
                continue;
            }

            // Check if any higher-priority labels in collision group are already placed
            const hasHigherPriorityPlaced = label.collisionGroup.some(otherIdx => 
                placed.has(otherIdx) && this.labels[otherIdx].mode !== LabelMode.HIDDEN
            );

            if (hasHigherPriorityPlaced) {
                // Need to offset this label in 3D
                label.mode = LabelMode.OFFSET_3D;
                
                // Calculate offset vector (stack vertically with slight horizontal shift)
                const stackLevel = Array.from(placed).filter(placedIdx => 
                    label.collisionGroup.includes(placedIdx)
                ).length;
                
                label.offsetVector = [
                    0.02 * stackLevel,      // Slight horizontal shift
                    0.02 * stackLevel,      // Slight vertical shift in screen space
                    0.05 * (stackLevel + 1) // Z-offset for 3D separation
                ];
            } else {
                // This is the highest priority, place directly
                label.mode = LabelMode.DIRECT;
            }

            placed.add(idx);
        }

        // Hide labels that are too crowded (>5 in collision group)
        for (const label of this.labels) {
            if (label.collisionGroup && label.collisionGroup.length > 5) {
                label.mode = LabelMode.HIDDEN;
            }
        }
    }
}
