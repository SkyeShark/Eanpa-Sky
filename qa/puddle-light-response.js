(async()=>{
    const T=THREE,p=_reflectionPipeline,r=p.pipeline.renderer,c=_c,l=_flashlight.light;
    _eanpaTest.pauseAfterFrame=true;while(!_eanpaTest.paused)await new Promise(done=>setTimeout(done,10));
    const position=c.position.clone(),quaternion=c.quaternion.clone(),lp=l.position.clone(),tp=l.target.position.clone();
    const enabled=_flashlight.state.enabled;
    const w=__eanpaWeatherByScene.get(c.parent),point=new T.Vector3(37.6558837890625,0,40.156288146972656);
    const values=[];
    const unpack=(a,width,height)=>{const row=Math.ceil(width*4*a.BYTES_PER_ELEMENT/256)*256/a.BYTES_PER_ELEMENT;
        if(a.length===width*height*4)return a;const out=new a.constructor(width*height*4);
        for(let y=0;y<height;y++)out.set(a.subarray(y*row,y*row+width*4),y*width*4);return out;};
    try{
        c.position.copy(point).add(new T.Vector3(0,2,3));c.lookAt(point);c.updateMatrixWorld(true);
        l.position.copy(point).add(new T.Vector3(0,2,-3)).applyMatrix4(c.matrixWorldInverse);
        l.target.position.copy(point).applyMatrix4(c.matrixWorldInverse);
        p.setAuditContributions({ssr:false,sky:false,probe:false});
        for(const on of [false,true]){
            _flashlight.setEnabled(on);c.updateMatrixWorld(true);await w.prepareFrame(r,c,{force:true});await p.render();
            const target=p.scenePass.renderTarget,width=target.width,height=target.height;
            const data=unpack(await r.readRenderTargetPixelsAsync(target,0,0,width,height),width,height);
            const f=T.DataUtils.fromHalfFloat;let maximum=0,sum=0,count=0;
            for(let y=Math.floor(height*.46);y<height*.54;y++)for(let x=Math.floor(width*.46);x<width*.54;x++){
                const i=(y*width+x)*4,v=f(data[i])*.2126+f(data[i+1])*.7152+f(data[i+2])*.0722;
                maximum=Math.max(maximum,v);sum+=v;count++;
            }
            values.push({on,maximum,mean:sum/count});
        }
        return{values,pass:values[1].maximum>values[0].maximum+1,layout:'light and camera mirrored about the surface normal',ior:1.333};
    }finally{
        c.position.copy(position);c.quaternion.copy(quaternion);l.position.copy(lp);l.target.position.copy(tp);
        _flashlight.setEnabled(enabled);c.updateMatrixWorld(true);p.setAuditContributions();await p.render();
    }
})()
