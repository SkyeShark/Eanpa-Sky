// Deterministic fragment drift in a common parent coordinate system. Every
// rotating mesh stays inside a pivot-centred sphere; every drift stays inside
// a second bounded envelope. Separating those envelopes guarantees clearance
// at all times, including between sampled animation frames.
export function makeFragmentMotion(T, pieces, {spread=1.75}={}) {
    if(!pieces.length)throw new Error('Fragment motion requires at least one mesh');
    const hash=(i,k)=>{const v=Math.sin(i*127.1+k*311.7)*43758.5453;return v-Math.floor(v)};
    const unit=(i,k)=>new T.Vector3(hash(i,k)-.5,hash(i,k+1)-.5,hash(i,k+2)-.5).normalize();
    const radii=pieces.map(p=>{
        const a=p.geometry.getAttribute('position');let radius=0;
        for(let i=0;i<a.count;i++)radius=Math.max(radius,Math.hypot(a.getX(i)*p.scale.x,a.getY(i)*p.scale.y,a.getZ(i)*p.scale.z));
        return radius;
    });
    const heroIndex=radii.indexOf(Math.max(...radii)),heroRadius=radii[heroIndex];
    const basePositions=pieces.map(p=>p.position.clone().multiply(new T.Vector3(spread,1,1)));
    const orientations=pieces.map(p=>p.quaternion.clone());
    const amplitudes=radii.map((r,i)=>(i === heroIndex ? .035 : .10)*r+heroRadius*.012);
    const clearance=heroRadius*.035;
    const envelopes=radii.map((r,i)=>r+amplitudes[i]);
    const mass=radii.map(r=>Math.max(1e-8,r*r*r));
    const direction=new T.Vector3();
    const center=new T.Vector3(),totalMass=mass.reduce((a,b)=>a+b,0);
    basePositions.forEach((p,i)=>center.addScaledVector(p,mass[i]/totalMass));
    let iterations=0;
    for(;iterations<256;iterations++){
        let largest=0;
        for(let i=0;i<pieces.length;i++)for(let j=i+1;j<pieces.length;j++){
            direction.subVectors(basePositions[j],basePositions[i]);
            const distance=direction.length(),overlap=envelopes[i]+envelopes[j]+clearance-distance;
            if(overlap<=1e-9)continue;
            largest=Math.max(largest,overlap);
            if(distance>1e-10)direction.multiplyScalar(1/distance);else direction.copy(unit(i,j+100));
            const move=overlap+1e-8,share=mass[j]/(mass[i]+mass[j]);
            basePositions[i].addScaledVector(direction,-move*share);
            basePositions[j].addScaledVector(direction,move*(1-share));
        }
        if(largest<1e-8)break;
    }
    const adjustedCenter=new T.Vector3();
    basePositions.forEach((p,i)=>adjustedCenter.addScaledVector(p,mass[i]/totalMass));
    adjustedCenter.sub(center);basePositions.forEach(p=>p.sub(adjustedCenter));
    let minimumEnvelopeClearance=Infinity;
    for(let i=0;i<pieces.length;i++)for(let j=i+1;j<pieces.length;j++)
        minimumEnvelopeClearance=Math.min(minimumEnvelopeClearance,basePositions[i].distanceTo(basePositions[j])-envelopes[i]-envelopes[j]);
    if(minimumEnvelopeClearance<clearance-1e-6)throw new Error('Could not separate fragment motion envelopes');
    const motion=pieces.map((_,i)=>{
        const u=unit(i,10),v=new T.Vector3().crossVectors(u,unit(i,20)).normalize();
        return {u,v,axis:unit(i,30),phase:hash(i,40)*Math.PI*2,
            frequency:Math.PI*2/(100+hash(i,41)*180),rate:(i === heroIndex ? .009 : .014+hash(i,42)*.018)};
    });
    const rotation=new T.Quaternion();
    return {basePositions,radii,heroIndex,amplitudes,
        stats:{fragments:pieces.length,minimumEnvelopeClearance,clearance,iterations},
        update(t){
            for(let i=0;i<pieces.length;i++){
                const m=motion[i],phase=m.phase+t*m.frequency;
                pieces[i].position.copy(basePositions[i])
                    .addScaledVector(m.u,Math.cos(phase)*amplitudes[i])
                    .addScaledVector(m.v,Math.sin(phase)*amplitudes[i]*.6);
                rotation.setFromAxisAngle(m.axis,t*m.rate);
                pieces[i].quaternion.copy(orientations[i]).multiply(rotation);
            }
        },
    };
}
