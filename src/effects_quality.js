const profiles = Object.freeze({
    balanced: Object.freeze({name: 'balanced', ssrDistance: 32, ssrQuality: 1, aoHalfRes: false, aoQuality: 'Medium'}),
    // Keep one sample per projected pixel; sparse sampling produces gaps on
    // curved reflective receivers. Reduce range and AO work instead.
    performance: Object.freeze({name: 'performance', ssrDistance: 24, ssrQuality: 1, aoHalfRes: true, aoQuality: 'Low'}),
});

export function effectsQuality(name) {
    return profiles[name] ?? profiles.balanced;
}
