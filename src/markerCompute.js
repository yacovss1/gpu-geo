// This file defines compute pipelines that accumulate hidden texture pixels per feature
// and then compute clip-space marker centers.

import { accumulatorShaderCode, centerShaderCode } from './shaders/computeShaders.js';

export function createAccumulatorPipeline(device) {
    return device.createComputePipeline({
        layout: 'auto',
        compute: {
            module: device.createShaderModule({ code: accumulatorShaderCode }),
            entryPoint: "main"
        }
    });
}

export function createCenterPipeline(device) {
    return device.createComputePipeline({
        layout: 'auto',
        compute: {
            module: device.createShaderModule({ code: centerShaderCode }),
            entryPoint: "main"
        }
    });
}
