// Solar-disc visibility through a finite ring cylinder, axis X. The far
// intersection is the opposite arc; the nearby ground is never an occluder.
export function ringSolarVisibility(point, sun, {radius=5000,centerY=4940,center={x:0,y:centerY,z:0},halfWidth=483,
    angularRadius=0.00465}={}) {
    if(sun.y<=0) return 1;
    const y=point.y-center.y,z=point.z-center.z,a=sun.y*sun.y+sun.z*sun.z;
    if(a<1e-10)return 1;
    const b=y*sun.y+z*sun.z,c=y*y+z*z-radius*radius;
    const discriminant=b*b-a*c;
    if(discriminant<0)return 1;
    const distance=(-b+Math.sqrt(discriminant))/a;
    if(distance<=1)return 1;
    const across=Math.abs(point.x-center.x+sun.x*distance);
    const penumbra=Math.max(1,distance*Math.tan(angularRadius)/Math.sqrt(a));
    const k=Math.max(0,Math.min(1,(across-halfWidth+penumbra)/(2*penumbra)));
    return k*k*(3-2*k);
}

// Per-fragment counterpart for the visible ring. A scene-wide eclipse scalar
// cannot describe a shadow sweeping over only part of a ten-kilometre arc.
export function ringSolarVisibilityNode(T,point,sun,{radius=5000,center,halfWidth=483,angularRadius=.00465}={}){
    return T.Fn(()=>{
        const p=point.sub(center),a=T.dot(sun.yz,sun.yz).max(.000001);
        const b=T.dot(p.yz,sun.yz),c=T.dot(p.yz,p.yz).sub(radius*radius);
        const discriminant=b.mul(b).sub(a.mul(c));
        const distance=b.negate().add(discriminant.max(0).sqrt()).div(a);
        const across=T.abs(p.x.add(sun.x.mul(distance)));
        const feather=distance.mul(Math.tan(angularRadius)).div(a.sqrt()).max(1);
        const visible=T.smoothstep(T.float(halfWidth).sub(feather),T.float(halfWidth).add(feather),across);
        return T.select(sun.y.greaterThan(0).and(discriminant.greaterThanEqual(0)).and(distance.greaterThan(1)),visible,1);
    })();
}
