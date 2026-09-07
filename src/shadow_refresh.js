// Keep the full-resolution map while avoiding repeated static-world shadow
// submissions between visible animation samples. A moving celestial light
// invalidates immediately; close player spotlights retain their own cadence.
export function makeShadowRefreshPolicy(T,light){
    const previous=new T.Vector3(Infinity,Infinity,Infinity),previousTarget=previous.clone();
    const position=new T.Vector3(),target=new T.Vector3();
    let next=-Infinity,last=-Infinity;
    const stats={requested:0,refreshHz:30};
    light.shadow.autoUpdate=false;
    return{stats,update(time,refreshHz=30){
        stats.refreshHz=refreshHz;
        light.getWorldPosition(position);light.target.getWorldPosition(target);
        const changed=position.distanceToSquared(previous)>.0025||target.distanceToSquared(previousTarget)>.0025;
        if(!light.shadow.map||changed||time>=next||time<last){
            light.shadow.needsUpdate=true;next=time+1/Math.max(1,refreshHz);
            previous.copy(position);previousTarget.copy(target);stats.requested++;
        }
        last=time;
    }};
}
