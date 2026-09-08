// Solar-disc visibility through a finite ring cylinder, axis X. The far
// intersection is the opposite arc; the nearby ground is never an occluder.
export function ringSolarVisibility(point, sun, {radius=5000,centerY=4940,halfWidth=483,
    angularRadius=0.00465}={}) {
    if(sun.y<=0) return 1;
    const y=point.y-centerY,z=point.z,a=sun.y*sun.y+sun.z*sun.z;
    if(a<1e-10)return 1;
    const b=y*sun.y+z*sun.z,c=y*y+z*z-radius*radius;
    const discriminant=b*b-a*c;
    if(discriminant<0)return 1;
    const distance=(-b+Math.sqrt(discriminant))/a;
    if(distance<=1)return 1;
    const across=Math.abs(point.x+sun.x*distance);
    const penumbra=Math.max(1,distance*Math.tan(angularRadius)/Math.sqrt(a));
    const k=Math.max(0,Math.min(1,(across-halfWidth+penumbra)/(2*penumbra)));
    return k*k*(3-2*k);
}
