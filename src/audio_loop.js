// Join an ambience recording's tail to its head once at decode time. The
// source stays untouched and playback still uses one looping buffer source.
export function blendAmbienceLoop(context, source, seconds = 0.18) {
    const overlap = Math.min(Math.floor(source.length / 4), Math.round(source.sampleRate * seconds));
    if (overlap < 2) return source;
    const length = source.length - overlap;
    const result = context.createBuffer(source.numberOfChannels, length, source.sampleRate);
    const bodyLength = source.length - overlap * 2;
    for (let channel = 0; channel < source.numberOfChannels; channel++) {
        const input = source.getChannelData(channel), output = result.getChannelData(channel);
        output.set(input.subarray(overlap, source.length - overlap));
        for (let i = 0; i < overlap; i++) {
            const weight = (1 - Math.cos(Math.PI * i / (overlap - 1))) * 0.5;
            // Complementary weights cannot introduce new sample peaks.
            output[bodyLength + i] = input[source.length - overlap + i] * (1 - weight)
                + input[i] * weight;
        }
    }
    return result;
}
