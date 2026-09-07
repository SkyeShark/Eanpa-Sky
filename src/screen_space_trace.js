// Screen-space radiance transport shared by native material lighting lobes.
// Continuous-depth intersection: Tomasz Stachowiak (2023),
// https://gist.github.com/h3r2tic/9c8356bdaefbe80b1a22ae0aaee192db
// Perspective ray projection adapted from Three.js SSRNode (MIT).
import { textureSize, perspectiveDepthToViewZ, orthographicDepthToViewZ,
    viewZToPerspectiveDepth, logarithmicDepthToViewZ, getScreenPosition, getViewPosition,
    float, bool, int, vec2, vec3, vec4, Fn, If, Loop, Continue, Break, min, max, mix,
    abs, sub, dot, cross, normalize } from 'three/tsl';

export function makeScreenSpaceTrace({ colorNode, depthNode, objectIdNode,
    camera, projection, projectionInverse, near, far, maxDistance, thickness, quality,
    logarithmicDepthBuffer = false }) {
    // textureSize is uvec2. Ray/viewport arithmetic must stay floating point;
    // integer division would reduce every clipped ray's extent to zero.
    const resolution = vec2(textureSize(depthNode));
    const getViewZ = depth => camera.isPerspectiveCamera
        ? perspectiveDepthToViewZ(depth, near, far) : orthographicDepthToViewZ(depth, near, far);
		const sampleDepth = ( uv ) => {

			const depth = depthNode.sample( uv ).r;

			if ( logarithmicDepthBuffer === true ) {

				const viewZ = logarithmicDepthToViewZ( depth, near, far );

				return viewZToPerspectiveDepth( viewZ, near, far );

			}

			return depth;

		};

		// A nearest-only depth field is a staircase at grazing angles. Use both
		// nearest and bilinear depth, as in Tomasz Stachowiak's depth-ray marcher:
		// https://gist.github.com/h3r2tic/9c8356bdaefbe80b1a22ae0aaee192db
		// Their farther value finds a continuous crossing; the nearer value
		// rejects interpolation across unrelated foreground/background surfaces.
		const depthRange = Fn( ( [ coord ] ) => {
			const pixel = coord.mul( resolution ).sub( 0.5 ).toVar();
			const base = pixel.floor().toVar();
			const f = pixel.fract().toVar();
			const at = offset => sampleDepth( base.add( offset ).add( 0.5 ).div( resolution ) );
			const d00 = at( vec2( 0, 0 ) ).toVar();
			const d10 = at( vec2( 1, 0 ) ).toVar();
			const d01 = at( vec2( 0, 1 ) ).toVar();
			const d11 = at( vec2( 1, 1 ) ).toVar();
			const linear = getViewZ( mix( mix( d00, d10, f.x ), mix( d01, d11, f.x ), f.y ) ).negate();
			const nearest = getViewZ( sampleDepth( coord ) ).negate();
			return vec2( min( nearest, linear ), max( nearest, linear ) );
		} );

    return Fn(([origin, direction, geometricNormal, receiverKey, rayRoughness]) => {
        const viewPosition = origin.toVar();
        const viewReflectDir = normalize(direction).toVar();
        const viewIncidentDir = normalize(viewPosition).toVar();
        const viewNormal = normalize(viewIncidentDir.negate().add(viewReflectDir));
        const receiverPlane = normalize(geometricNormal).toVar();
        const receiverId = receiverKey;
        const minHitSeparation = max(thickness.mul(0.01), 0.001);
        const outputValue = vec4(0).toVar();
        If(dot(viewReflectDir,receiverPlane).greaterThan(0.001).and(rayRoughness.lessThan(0.8)),()=>{
			// adapt maximum distance to the local geometry (see https://www.mathsisfun.com/algebra/vectors-dot-product.html)
			const maxReflectRayLen = maxDistance.div( max( dot( viewIncidentDir.negate(), viewNormal ), 0.05 ) ).toVar();

			// compute the maximum point of the reflection ray in view space
			const d1viewPosition = viewPosition.add( viewReflectDir.mul( maxReflectRayLen ) ).toVar();

			// check if d1viewPosition lies behind the camera near plane
			If( bool(camera.isPerspectiveCamera).and( d1viewPosition.z.greaterThan( near.negate() ) ), () => {

				// if so, ensure d1viewPosition is clamped on the near plane.
				// this prevents artifacts during the ray marching process
				const t = sub( near.negate(), viewPosition.z ).div( viewReflectDir.z );
				d1viewPosition.assign( viewPosition.add( viewReflectDir.mul( t ) ) );

			} );

			// d0 and d1 are the start and maximum points of the reflection ray in screen space
			const d0 = getScreenPosition( viewPosition, projection ).mul( resolution ).toVar();
			const d1 = getScreenPosition( d1viewPosition, projection ).mul( resolution ).toVar();

			const delta = d1.sub( d0 ).toVar();
			const rayPixels = max( abs( delta.x ), abs( delta.y ) ).toVar();
			// Subpixel rays naturally retain zero coverage below.
			// Clip the march to the viewport before distributing samples. A ray
			// clipped at the camera near plane can otherwise be millions of pixels.
			const endS = float( 1 ).toVar();
			for ( const axis of [ 'x', 'y' ] ) {
				If( delta[ axis ].greaterThan( 0.00001 ), () => {
					endS.assign( min( endS, resolution[ axis ].sub( d0[ axis ] ).sub( 1 ).div( delta[ axis ] ) ) );
				} ).ElseIf( delta[ axis ].lessThan( - 0.00001 ), () => {
					endS.assign( min( endS, d0[ axis ].sub( 1 ).negate().div( delta[ axis ] ) ) );
				} );
			}
			endS.assign( endS.max( 0 ) );
			const totalStep = int( rayPixels.mul( endS ).mul( quality.clamp() ).ceil().clamp( 1, 128 ) ).toConst();
			const invZ0 = viewPosition.z.reciprocal().toConst();
			const invZ1 = d1viewPosition.z.reciprocal().toConst();
			const rayZAt = camera.isPerspectiveCamera
				? s => mix( invZ0, invZ1, s ).reciprocal().negate()
				: s => mix( viewPosition.z, d1viewPosition.z, s ).negate();
			const uvAt = s => d0.add( delta.mul( s ) ).div( resolution );
			const bias = max( viewPosition.z.abs().mul( 0.000002 ), 0.0002 ).toVar();
			const previousS = float( 0 ).toVar();
			const lo = float( 0 ).toVar();
			const hi = float( 0 ).toVar();
			const found = bool( false ).toVar();
			const output = vec4( 0 ).toVar();
			const isSelf = coord => receiverId !== null
				? receiverId.greaterThan( 1.5 ).and( abs( objectIdNode.sample( coord ).sub( receiverId ) ).lessThan( 0.25 ) )
				: bool( false );

			Loop( { start: int( 1 ), end: totalStep.add( 1 ), type: 'int', condition: '<' }, ( { i } ) => {
				// Quadratic spacing preserves nearby detail with a fixed cost.
				const fraction = float( i ).div( totalStep );
				const s = fraction.mul( fraction ).mul( endS ).toVar();
				const coord = uvAt( s ).toVar();
				If( isSelf( coord ), () => { previousS.assign( s ); Continue(); } );
				const range = depthRange( coord ).toVar();
				If( rayZAt( s ).greaterThanEqual( range.y.add( bias ) ), () => {
					lo.assign( previousS ); hi.assign( s ); found.assign( true ); Break();
				} );
				previousS.assign( s );
			} );

			If( found, () => {
				// Refine the crossing, not merely the first sample inside a thick
				// depth slab. This removes the alternating hit/miss contour bands.
				Loop( 6, () => {
					const s = lo.add( hi ).mul( 0.5 ).toVar();
					const coord = uvAt( s ).toVar();
					If( isSelf( coord ).not().and( rayZAt( s ).greaterThanEqual( depthRange( coord ).y.add( bias ) ) ), () => {
						hi.assign( s );
					} ).Else( () => { lo.assign( s ); } );
				} );
				const coord = uvAt( hi ).toVar();
				const range = depthRange( coord ).toVar();
				const penetration = rayZAt( hi ).sub( range.x );
				const hitDepth = sampleDepth( coord ).toVar();
				const hitPosition = getViewPosition( coord, hitDepth, projectionInverse ).toVar();
				const separation = hitPosition.sub( viewPosition ).toVar();
				// Stop at the first surface even if its crossing cannot be resolved.
				// Marching through rejected occluders leaks unrelated objects into SSR.
				If( penetration.lessThanEqual( thickness )
					.and( hitDepth.lessThan( 0.999999 ) )
					.and( dot( separation, receiverPlane ).greaterThan( minHitSeparation ) ), () => {
					// Test geometric orientation, not the hit's normal map. Bump
					// normals describe shading and cannot punch holes in an occluder.
					const dx = vec2( 1, 0 ).div( resolution );
					const dy = vec2( 0, 1 ).div( resolution );
					const at = uv => getViewPosition( uv, sampleDepth( uv ), projectionInverse );
					const right = at( coord.add( dx ) ).sub( hitPosition ).toVar();
					const left = hitPosition.sub( at( coord.sub( dx ) ) ).toVar();
					const down = at( coord.add( dy ) ).sub( hitPosition ).toVar();
					const up = hitPosition.sub( at( coord.sub( dy ) ) ).toVar();
					const tangentX = left.toVar();
					const tangentY = up.toVar();
					If( abs( right.z ).lessThan( abs( left.z ) ), () => { tangentX.assign( right ); } );
					If( abs( down.z ).lessThan( abs( up.z ) ), () => { tangentY.assign( down ); } );
					const normal = normalize( cross( tangentX, tangentY ) ).toVar();
					If( dot( normal, hitPosition ).greaterThan( 0 ), () => { normal.mulAssign( - 1 ); } );
					If( dot( normal, viewReflectDir ).lessThan( 0 ), () => {
						// Filter incoming light over the projected specular cone, not
						// neighbouring receivers with unrelated normals/materials.
						const focalPixels = resolution.y.mul( projection[ 1 ][ 1 ] ).mul( 0.5 );
						const footprint = rayRoughness.mul( rayRoughness ).mul( 2 )
							.mul( separation.length() ).mul( focalPixels ).div( hitPosition.z.abs().max( 0.01 ) ).max( 1 );
						const lod = footprint.log2().max( 0 );
						const color = colorNode.sample( coord ).level( lod );
						const border = min( min( coord.x, coord.y ), min( coord.x.oneMinus(), coord.y.oneMinus() ) );
						const fadeWidth = footprint.div( min( resolution.x, resolution.y ) ).mul( 2 ).clamp( 0.04, 0.15 );
						const confidence = border.smoothstep( 0.003, fadeWidth )
							.mul( rayRoughness.smoothstep( 0.55, 0.8 ).oneMinus() );
						output.assign( vec4( color.rgb.mul( confidence ), color.a.mul( confidence ) ) );
					} );
				} );
			} );

            outputValue.assign(output);
        });
        return outputValue;
    });
}
