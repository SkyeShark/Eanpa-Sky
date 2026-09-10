// One light-column field for every receiving material. Two completed captures
// share an atlas and sampler, so temporal blending does not repeatedly filter
// or resample the previous field. The host serializes prepare() with rendering.
export function makeCloudShadowMap(T, {transmittance, lightDirection, time, displacement,
    resolution=384, extent=6144, verticalSpan=1024, refreshSeconds=.1}={}) {
    const size=Math.max(64,Math.round(resolution));
    const target=new T.RenderTarget(size*2,size,{type:T.HalfFloatType,depthBuffer:false,
        minFilter:T.LinearFilter,magFilter:T.LinearFilter,generateMipmaps:false});
    target.texture.name='cloud-column-transmittance';
    const shared=value=>T.uniform(value).setGroup(T.renderGroup);
    const origin=shared(new T.Vector3()),captureLight=shared(new T.Vector3(0,1,0)),ready=shared(0);
    const right=shared(new T.Vector3(1,0,0)),up=shared(new T.Vector3(0,0,-1));
    const span=shared(new T.Vector2(extent,extent)),captureDisplacement=shared(new T.Vector3());
    const oldOrigin=shared(new T.Vector3()),oldRight=shared(new T.Vector3(1,0,0)),oldUp=shared(new T.Vector3(0,0,-1));
    const oldSpan=shared(new T.Vector2(extent,extent)),oldDisplacement=shared(new T.Vector3());
    const tile=shared(0),oldTile=shared(1),capturedAt=shared(0),historyReady=shared(0);
    const material=new T.MeshBasicNodeMaterial();material.name='Cloud shadow column integration';
    const p=origin.add(right.mul(T.uv().x.sub(.5).mul(span.x)))
        .add(up.mul(T.uv().y.sub(.5).mul(span.y)));
    material.fragmentNode=T.vec4(transmittance(p),0,0,1);
    const quad=new T.QuadMesh(material),captureContext=T.context({});
    const map=T.texture(target.texture,T.screenUV);
    const stats={resolution:size,extent,refreshSeconds,captures:0,projection:'orthographic-light-columns',
        publication:'two-capture-atlas',receiverTextureReads:'one when settled, two during blending'};
    const cameraWorld=new T.Vector3(),nextOrigin=new T.Vector3(),nextRight=new T.Vector3(),nextUp=new T.Vector3();
    let current=0,lastTime=-Infinity,disposed=false;
    const sampleField=(world,center,basisRight,basisUp,bounds,driftAtCapture,index)=>{
        const drift=displacement?displacement.sub(driftAtCapture):T.vec3(0);
        const relative=world.sub(center).sub(drift);
        const uv=T.vec2(T.dot(relative,basisRight),T.dot(relative,basisUp)).div(bounds).add(.5);
        const edge=T.max(T.abs(uv.x.sub(.5)),T.abs(uv.y.sub(.5)));
        const weight=T.smoothstep(.46,.5,edge).oneMinus();
        // Linear filtering must stay within this tile's texel centres.
        const safeUV=uv.clamp(.5/size,1-.5/size);
        const atlasUV=T.vec2(safeUV.x.add(index).mul(.5),safeUV.y);
        return T.mix(1,map.sample(atlasUV).level(0).r,weight);
    };
    return {target,stats,projection:{origin,right,up,span,light:captureLight},
        sample(world){return T.Fn(()=>{
            const value=sampleField(world,origin,right,up,span,captureDisplacement,tile).toVar();
            const blend=time.sub(capturedAt).div(refreshSeconds).clamp();
            T.If(historyReady.greaterThan(0).and(blend.lessThan(1)),()=>{
                const previous=sampleField(world,oldOrigin,oldRight,oldUp,oldSpan,oldDisplacement,oldTile);
                value.assign(T.mix(previous,value,blend));
            });
            return T.mix(1,value,ready);
        })();},
        async prepare(renderer,camera,force=false){
            if(disposed||!camera)return false;
            if(typeof force==='object')force=force?.force===true;
            const light=lightDirection.value,t=time.value;
            camera.getWorldPosition(cameraWorld);
            nextRight.set(light.z,0,-light.x);
            if(nextRight.lengthSq()<.000001)nextRight.set(1,0,0);else nextRight.normalize();
            nextUp.crossVectors(light,nextRight).normalize();
            // Project the ground footprint and host height instead of wasting
            // most of a square light-plane map's rows above/below the host.
            const spanY=Math.max(verticalSpan,extent*Math.abs(light.y)+verticalSpan*Math.abs(nextUp.y));
            const texelX=extent/size,texelY=spanY/size;
            const x=Math.floor(cameraWorld.dot(nextRight)/texelX)*texelX;
            const y=Math.floor(cameraWorld.dot(nextUp)/texelY)*texelY;
            const along=cameraWorld.dot(light)-(cameraWorld.y+64+spanY*.5*Math.abs(nextUp.y))/Math.max(light.y,.001);
            nextOrigin.copy(nextRight).multiplyScalar(x).addScaledVector(nextUp,y).addScaledVector(light,along);
            const relative=cameraWorld.clone().sub(origin.value);
            const moved=Math.abs(relative.dot(right.value))>span.value.x*.125||Math.abs(relative.dot(up.value))>span.value.y*.125;
            const lightAlignment=captureLight.value.dot(light),turned=lightAlignment<1-1e-10;
            const lightJump=lightAlignment<.995;
            // Retain the older tile until its blend finishes. Normal movement
            // has a generous guard band and can wait for this cadence.
            if(!force&&ready.value&&!lightJump&&t>=lastTime&&t-lastTime<refreshSeconds)return false;
            const saved={target:renderer.getRenderTarget(),mrt:renderer.getMRT(),context:renderer.contextNode,autoClear:renderer.autoClear};
            const savedOrigin=origin.value.clone(),savedLight=captureLight.value.clone(),savedDisplacement=captureDisplacement.value.clone();
            const savedRight=right.value.clone(),savedUp=up.value.clone(),savedSpan=span.value.clone();
            const next=1-current;
            try{
                // Fixed-sun walking retains a world-stable lattice. On a day
                // cycle, each completed capture matches its current ray direction.
                if(!ready.value||moved||turned){origin.value.copy(nextOrigin);right.value.copy(nextRight);up.value.copy(nextUp);span.value.set(extent,spanY);}
                captureLight.value.copy(light);
                if(displacement)captureDisplacement.value.copy(displacement.value);
                target.viewport.set(next*size,0,size,size);target.scissor.copy(target.viewport);target.scissorTest=true;
                renderer.setMRT(null);renderer.contextNode=captureContext;renderer.setRenderTarget(target);
                // The opaque quad overwrites its tile; retain the other half.
                renderer.autoClear=false;await quad.renderAsync(renderer);
                oldOrigin.value.copy(savedOrigin);oldRight.value.copy(savedRight);oldUp.value.copy(savedUp);
                oldSpan.value.copy(savedSpan);oldDisplacement.value.copy(savedDisplacement);oldTile.value=current;
                historyReady.value=!force&&ready.value&&!lightJump&&t>=lastTime?1:0;
                current=next;tile.value=current;capturedAt.value=t;
                ready.value=1;lastTime=t;stats.captures++;return true;
            }catch(error){
                origin.value.copy(savedOrigin);captureLight.value.copy(savedLight);captureDisplacement.value.copy(savedDisplacement);
                right.value.copy(savedRight);up.value.copy(savedUp);span.value.copy(savedSpan);throw error;
            }finally{
                renderer.autoClear=saved.autoClear;renderer.contextNode=saved.context;
                renderer.setRenderTarget(saved.target);renderer.setMRT(saved.mrt);
            }
        },
        dispose(){if(disposed)return;disposed=true;target.dispose();material.dispose();},
    };
}
