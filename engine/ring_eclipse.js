// Solar-disc visibility from the inside of a finite opaque cylinder, axis X.
// Its exit is the opposite arc when the sun is above the receiver's local
// horizon, and the nearby ground when the sun is below it. Both block light.
const radialRoundoff = radius => 2*radius*Math.max(.001,radius*1e-6);
// Preserve the authored night-side ring illumination without switching its
// atmosphere abruptly when the sun centre crosses the observer's horizon.
const twilightElevation = .05;

export function ringSolarVisibility(point, sun, {radius=5000,centerY=4940,center={x:0,y:centerY,z:0},halfWidth=483,
    angularRadius=0.00465}={}) {
    if(sun.y<=0) return 1;
    const y=point.y-center.y,z=point.z-center.z,a=sun.y*sun.y+sun.z*sun.z;
    if(a<1e-10)return 1;
    const b=y*sun.y+z*sun.z,c=y*y+z*z-radius*radius;
    const discriminant=b*b-a*c;
    // Water lies on the cylinder itself. Discarding short shadow rays made
    // that water abruptly unshadowed at the solar tangent while mountains
    // stayed dark. Classify the origin radially instead; a tiny float-sized
    // tolerance keeps GPU surface roundoff from reopening the same seam.
    const inside=c<=radialRoundoff(radius);
    if(discriminant<0&&!inside)return 1;
    const exitDistance=(-b+Math.sqrt(Math.max(0,discriminant)))/a;
    if(exitDistance<0&&!inside)return 1;
    const distance=Math.max(0,exitDistance);
    const across=Math.abs(point.x-center.x+sun.x*distance);
    const penumbra=Math.max(1,distance*Math.tan(angularRadius)/Math.sqrt(a));
    const k=Math.max(0,Math.min(1,(across-halfWidth+penumbra)/(2*penumbra)));
    const day=Math.min(1,sun.y/twilightElevation),daylight=day*day*(3-2*day);
    return 1-(1-k*k*(3-2*k))*daylight;
}

// Per-fragment counterpart for the visible ring. A scene-wide eclipse scalar
// cannot describe a shadow sweeping over only part of a ten-kilometre arc.
export function ringSolarVisibilityNode(T,point,sun,{radius=5000,center,halfWidth=483,angularRadius=.00465}={}){
    return T.Fn(()=>{
        const p=point.sub(center),a=T.dot(sun.yz,sun.yz).max(.000001);
        const b=T.dot(p.yz,sun.yz),c=T.dot(p.yz,p.yz).sub(radius*radius);
        const discriminant=b.mul(b).sub(a.mul(c));
        const inside=c.lessThanEqual(radialRoundoff(radius));
        const exitDistance=b.negate().add(discriminant.max(0).sqrt()).div(a);
        const distance=exitDistance.max(0);
        const across=T.abs(p.x.add(sun.x.mul(distance)));
        const feather=distance.mul(Math.tan(angularRadius)).div(a.sqrt()).max(1);
        const visible=T.smoothstep(T.float(halfWidth).sub(feather),T.float(halfWidth).add(feather),across);
        const hit=inside.or(discriminant.greaterThanEqual(0).and(exitDistance.greaterThanEqual(0)));
        const daylight=T.smoothstep(0,twilightElevation,sun.y);
        return T.mix(1,T.select(hit,visible,1),daylight);
    })();
}
