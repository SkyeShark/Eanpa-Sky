(async()=>{
    const f=__skyFixture,T=THREE;
    if(!_eanpaTest.paused){_eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(r=>setTimeout(r,10));}
    f.weather.setWeather('darkstorm');f.impacts.length=0;
    await new Promise(requestAnimationFrame);await f.frame(f.time+1/60);
    const forced=f.weather.debugForceLocalStrike(),start=f.time,frames=[];let firstImpactFrame=null;
    for(let i=1;i<=80;i++){
        await new Promise(requestAnimationFrame);await f.frame(start+i/30);
        if(f.impacts.length&&[0,3,12,30].includes(i-(firstImpactFrame??=i))){
            await f.renderer.backend.device.queue.onSubmittedWorkDone();
            frames.push({time:f.time,png:f.renderer.domElement.toDataURL('image/png')});
        }
    }
    const impact=f.impacts[0],point=impact?new T.Vector3().fromArray(impact.point):null;
    return{forced,pass:forced&&f.impacts.length>0&&!f.errors.length,impacts:f.impacts,
        diagnostics:f.weather.diagnostics.lightning,frames,errors:[...f.errors],point:point?.toArray()};
})()
