export async function initWebGPU(canvas) {
    if (!navigator.gpu) {
        throw new Error('WebGPU is not supported on this browser.');
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error('WebGPU adapter is not available.');
    }

    const device = await adapter.requestDevice();
    
    // Handle device loss
    device.lost.then((info) => {
        console.error('GPU device lost:', info.reason, info.message);
        if (info.reason !== 'destroyed') {
            // Device was lost unexpectedly - could reload
            console.error('GPU device lost unexpectedly. Page may need refresh.');
        }
    });
    
    // Log uncaptured errors with full details
    device.addEventListener('uncapturederror', (event) => {
        console.error('WebGPU uncaptured error:', event.error);
        console.error('Error details:', {
            message: event.error.message,
            reason: event.error.reason
        });
        // Print stack trace if available
        if (event.error.stack) {
            console.error('Stack:', event.error.stack);
        }
    });
    
    const context = canvas.getContext('webgpu');

    const devicePixelRatio = window.devicePixelRatio || 1;
    const canvasWidth = canvas.clientWidth * devicePixelRatio;
    const canvasHeight = canvas.clientHeight * devicePixelRatio;
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    context.configure({
        device: device,
        format: navigator.gpu.getPreferredCanvasFormat(),
        alphaMode: 'premultiplied',
    });

    return { device, context };
}