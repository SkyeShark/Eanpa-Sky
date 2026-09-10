// One cylindrical atlas supplies the distant ring's visible cloud sheet and
// direct-light transmission. Local volumetric clouds retain their world map.
export function makeRingCloudField(T, uniforms, time, {width=2048,height=64,refreshSeconds=.2}={}) {
    const {vec2,vec3,vec4,float,fract,floor,mix,smoothstep,uniform}=T;
    const target=new T.RenderTarget(width,height,{depthBuffer:false,generateMipmaps:true,
        minFilter:T.LinearMipmapLinearFilter,magFilter:T.LinearFilter});
    target.texture.name='ring-cloud-coverage';target.texture.wrapS=T.RepeatWrapping;
    const ready=uniform(0).setGroup(T.renderGroup);
    const capturedDisplacement=uniform(new T.Vector2()).setGroup(T.renderGroup);
    const hash=p=>{
        const a=fract(vec3(p.x,p.y,p.x).mul(.1031));
        const b=a.add(T.dot(a,vec3(a.y,a.z,a.x).add(33.33)));
        return fract(b.x.add(b.y).mul(b.z));
    };
    const noise=(p,repeat)=>{
        const i=T.mod(floor(p),repeat),f=fract(p),s=f.mul(f).mul(float(3).sub(f.mul(2)));
        const at=(x,y)=>hash(T.mod(i.add(vec2(x,y)),repeat));
        return mix(mix(at(0,0),at(1,0),s.x),mix(at(0,1),at(1,1),s.x),s.y);
    };
    const coordinate=T.uv(),drift=uniforms.displacement;
    const octave=(n,weight,direction,warp)=>{
        let p=coordinate.sub(drift).mul(vec2(n,n/33.4));
        if(warp)p=p.add(warp.mul(n*.012));
        return noise(p,vec2(n,1e6)).mul(weight);
    };
    const macro=octave(6,1,1);
    const warp=vec2(octave(10,1,.6).sub(.5),octave(10,1,-.7).sub(.5));
    const filaments=octave(40,.38,1,warp).add(octave(80,.26,-.8,warp))
        .add(octave(160,.19,1.3,warp)).add(octave(320,.12,-1.1,warp)).add(octave(640,.07,.9,warp));
    const field=macro.mul(.62).add(filaments.mul(.55));
    const threshold=float(.88).sub(uniforms.cover.mul(.55));
    const edge=smoothstep(.02,.15,coordinate.y).mul(float(1).sub(smoothstep(.85,.98,coordinate.y)));
    const coverage=smoothstep(threshold,threshold.add(.15),field)
        .mul(float(.85).sub(uniforms.grey.mul(.12))).mul(uniforms.dens).clamp(0,1);
    const material=new T.MeshBasicNodeMaterial({toneMapped:false,fog:false});
    material.fragmentNode=vec4(coverage,field,0,1);
    const quad=new T.QuadMesh(material),context=T.context({});
    const stats={width,height,refreshSeconds,captures:0,lastTime:null};
    let disposed=false,last=-Infinity;
    return {stats,target,
        sample(uv){
            const advected=uv.sub(uniforms.displacement.sub(capturedDisplacement));
            const data=T.texture(target.texture,advected);
            const edge=smoothstep(.02,.15,uv.y).mul(float(1).sub(smoothstep(.85,.98,uv.y)));
            return vec2(data.r.mul(ready).mul(edge),data.g);
        },
        async prepare(renderer,t,force=false){
            if(disposed||(!force&&t>=last&&t-last<refreshSeconds))return false;
            const state=T.RendererUtils.saveRendererState(renderer),previousContext=renderer.contextNode;
            try {
                renderer.contextNode=context;renderer.setMRT(null);renderer.setRenderTarget(target);
                await quad.renderAsync(renderer);capturedDisplacement.value.copy(uniforms.displacement.value);
                ready.value=1;last=t;stats.lastTime=t;stats.captures++;
            }finally{renderer.contextNode=previousContext;T.RendererUtils.restoreRendererState(renderer,state);}
            return true;
        },
        dispose(){if(disposed)return;disposed=true;ready.value=0;material.dispose();target.dispose();},
    };
}
