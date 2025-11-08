export async function initWebGPU(canvas) {
    if (!navigator.gpu) {
        throw new Error('WebGPU is not supported on this browser.');
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error('WebGPU adapter is not available.');
    }

    const device = await adapter.requestDevice();
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