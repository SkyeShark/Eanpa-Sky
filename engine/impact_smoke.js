// Bounded participating volume for the pooled lightning impact particles.
// Unit-sphere coordinates must be read before the instance's world placement.
export function makeImpactSmoke(T,{age,life,alpha,color,glowColor,sceneLight}) {
    const {Fn,float,vec3,vec4,mix,smoothstep,exp,max,dot,length}=T;
    const noise3=Fn(([p])=>T.mx_noise_float(p).mul(.5).add(.5));
    return Fn(()=>{
        const seed=T.hash(T.uint(T.instanceIndex).add(T.uint(719))).toVar();
        const xy=T.positionGeometry.xy.toVar();
        const chord=T.sqrt(max(float(1).sub(dot(xy,xy)),0)).toVar();
        const dt=chord.mul(2/8).toVar(),trans=float(1).toVar(),radiance=vec3(0).toVar();
        T.Loop({start:0,end:8,type:'int'},({i})=>{
            const p=vec3(xy,chord.sub(float(i).add(.5).mul(dt))).toVar();
            const adv=p.mul(2.8).add(vec3(seed.mul(31.7),age.mul(-.38),seed.mul(11.3)));
            const noise=noise3(adv).mul(.72).add(noise3(adv.mul(2.13).add(17.9)).mul(.28)).toVar();
            const edge=float(1).sub(smoothstep(.50,.98,length(p).add(noise.sub(.5).mul(.65))));
            // Erode the interior as well as the silhouette. A low threshold
            // filled almost every sample and twelve overlapping bodies became
            // an opaque balloon with no readable turbulent structure.
            const density=smoothstep(.46,.69,noise).pow(1.4).mul(edge).mul(2.4);
            const absorption=float(1).sub(exp(density.mul(dt).negate()));
            const illumination=smoothstep(-.8,.8,p.y).mul(.65).add(.35);
            const smoke=color.mul(illumination).mul(sceneLight.mul(2.8).add(.55));
            const heat=exp(age.mul(-12)).mul(exp(dot(p,p).mul(-4)));
            const source=smoke.add(mix(glowColor,vec3(1),.65).mul(heat).mul(5));
            radiance.addAssign(trans.mul(absorption).mul(source));
            trans.mulAssign(float(1).sub(absorption));
        });
        const opacity=float(1).sub(trans),fade=float(1).sub(smoothstep(.4,1,life));
        return vec4(radiance.div(max(opacity,.001)),opacity.mul(fade).mul(alpha).mul(.32));
    })();
}
