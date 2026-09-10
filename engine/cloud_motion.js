// Wind is a velocity, not a phase. Integrating it avoids a discontinuous
// cloud displacement when a weather transition changes wind after hours of play.
export function createCloudMotion(){
    const offset={x:0,y:0,z:0},previous={x:0,y:0,z:0};let last=null;
    return {offset,
        update(time,wind){
            if(!Number.isFinite(time))return offset;
            if(last!==null&&time>=last){
                const dt=time-last;
                for(const axis of ['x','y','z'])offset[axis]+=(previous[axis]+(wind[axis]??0))*.5*dt;
            }
            last=time;for(const axis of ['x','y','z'])previous[axis]=wind[axis]??0;
            return offset;
        },
    };
}
