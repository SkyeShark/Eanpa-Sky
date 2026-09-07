import { HalfFloatType, RenderTarget, Vector2, RendererUtils, QuadMesh, TempNode, NodeMaterial, NodeUpdateType, LinearFilter, LinearMipmapLinearFilter } from 'three/webgpu';
import { texture, reference, viewZToPerspectiveDepth, logarithmicDepthToViewZ, getScreenPosition, getViewPosition, mul, div, cross, float, bool, min, mix, Continue, Break, Loop, int, max, abs, sub, If, dot, reflect, normalize, screenCoordinate, nodeObject, Fn, passTexture, uv, uniform, perspectiveDepthToViewZ, orthographicDepthToViewZ, vec2, vec3, vec4 } from 'three/tsl';
import { boxBlur } from './boxBlur.js';

const _quadMesh = /*@__PURE__*/ new QuadMesh();
const _size = /*@__PURE__*/ new Vector2();
let _rendererState;

/**
 * Post processing node for computing screen space reflections (SSR).
 *
 * Reference: {@link https://lettier.github.io/3d-game-shaders-for-beginners/screen-space-reflection.html}
 *
 * @augments TempNode
 * @three_import import { ssr } from 'three/addons/tsl/display/SSRNode.js';
 */
class SSRNode extends TempNode {

	static get type() {

		return 'SSRNode';

	}

	/**
	 * Constructs a new SSR node.
	 *
	 * @param {Node<vec4>} colorNode - The node that represents the beauty pass.
	 * @param {Node<float>} depthNode - A node that represents the beauty pass's depth.
	 * @param {Node<vec3>} normalNode - A node that represents the beauty pass's normals.
	 * @param {Node<float>} metalnessNode - A node that represents the beauty pass's metalness.
	 * @param {?Node<float>} [roughnessNode=null] - A node that represents the beauty pass's roughness.
	 * @param {?Camera} [camera=null] - The camera the scene is rendered with.
	 */
	constructor( colorNode, depthNode, normalNode, metalnessNode, roughnessNode = null, camera = null ) {

		super( 'vec4' );

		/**
		 * The node that represents the beauty pass.
		 *
		 * @type {Node<vec4>}
		 */
		this.colorNode = colorNode;

		/**
		 * A node that represents the beauty pass's depth.
		 *
		 * @type {Node<float>}
		 */
		this.depthNode = depthNode;

		/**
		 * A node that represents the beauty pass's normals.
		 *
		 * @type {Node<vec3>}
		 */
		this.normalNode = normalNode;

		/**
		 * A node that represents the beauty pass's metalness.
		 *
		 * @type {Node<float>}
		 */
		this.metalnessNode = metalnessNode;

		/**
		 * Whether the SSR reflections should be blurred or not. Blurring is a costly
		 * operation so turn it off if you encounter performance issues on certain
		 * devices.
		 *
		 * @private
		 * @type {Node<float>}
		 * @default false
		 */
		this.roughnessNode = roughnessNode;

		/**
		 * Optional resolved RGB specular response for the receiving pixel. When
		 * supplied, SSR uses this native-material DFG/F0 response instead of the
		 * legacy scalar metalness/Fresnel approximation. As in the donor renderer,
		 * alpha is a strict accepted-hit mask: one when this ray found geometry and
		 * zero on a miss. Roughness filtering may spatially filter that mask together
		 * with RGB, but an accepted sharp hit never shares ownership with the sky
		 * fallback. The default remains the upstream SSR behavior.
		 *
		 * @type {?Node<vec3>}
		 * @default null
		 */
		this.specularResponseNode = null;

		// Optional exact convex-receiver group IDs. IDs > 1 exclude self hits;
		// ordinary/concave geometry keeps 0/1 and the upstream tracing behavior.
		this.objectIdNode = null;

		/**
		 * The resolution scale. Valid values are in the range
		 * `[0,1]`. `1` means best quality but also results in
		 * more computational overhead. Setting to `0.5` means
		 * the effect is computed in half-resolution.
		 *
		 * @type {number}
		 * @default 1
		 */
		this.resolutionScale = 1;

		/**
		 * The `updateBeforeType` is set to `NodeUpdateType.FRAME` since the node renders
		 * its effect once per frame in `updateBefore()`.
		 *
		 * @type {string}
		 * @default 'frame'
		 */
		this.updateBeforeType = NodeUpdateType.FRAME;

		/**
		 * Controls how far a fragment can reflect. Increasing this value result in more
		 * computational overhead but also increases the reflection distance.
		 *
		 * @type {UniformNode<float>}
		 */
		this.maxDistance = uniform( 1 );

		/**
		 * Controls the cutoff between what counts as a possible reflection hit and what does not.
		 *
		 * @type {UniformNode<float>}
		 */
		this.thickness = uniform( 0.1 );

		/**
		 * Controls how the SSR reflections are blended with the beauty pass.
		 *
		 * @type {UniformNode<float>}
		 */
		this.opacity = uniform( 1 );

		/**
		 * This parameter controls how detailed the raymarching process works.
		 * The value ranges is `[0,1]` where `1` means best quality (the maximum number
		 * of raymarching iterations/samples) and `0` means no samples at all.
		 *
		 * A quality of `0.5` is usually sufficient for most use cases. Try to keep
		 * this parameter as low as possible. Larger values result in noticeable more
		 * overhead.
		 *
		 * @type {UniformNode<float>}
		 */
		this.quality = uniform( 0.5 );

		// App-selectable roughness limit. The default preserves upstream coverage;
		// rough surfaces can use their angularly filtered environment instead.
		this.maxRoughness = uniform( 1 );

		// Optional angular footprint adjustment for the application's pixel
		// density. Keep the upstream default for other users of this addon.
		this.roughnessBlurScale = uniform( 1 );

		/**
		 * The quality of the blur. Must be an integer in the range `[1,3]`.
		 *
		 * @type {UniformNode<int>}
		 */
		this.blurQuality = uniform( 2 );

		//

		if ( camera === null ) {

			if ( this.colorNode.passNode && this.colorNode.passNode.isPassNode === true ) {

				camera = this.colorNode.passNode.camera;

			} else {

				throw new Error( 'THREE.TSL: No camera found. ssr() requires a camera.' );

			}

		}

		/**
		 * The camera the scene is rendered with.
		 *
		 * @type {Camera}
		 */
		this.camera = camera;

		/**
		 * The spread of the blur. Automatically set when generating mips.
		 *
		 * @private
		 * @type {UniformNode<int>}
		 */
		this._blurSpread = uniform( 1 );

		/**
		 * Represents the projection matrix of the scene's camera.
		 *
		 * @private
		 * @type {UniformNode<mat4>}
		 */
		this._cameraProjectionMatrix = uniform( camera.projectionMatrix );

		/**
		 * Represents the inverse projection matrix of the scene's camera.
		 *
		 * @private
		 * @type {UniformNode<mat4>}
		 */
		this._cameraProjectionMatrixInverse = uniform( camera.projectionMatrixInverse );

		/**
		 * Represents the near value of the scene's camera.
		 *
		 * @private
		 * @type {ReferenceNode<float>}
		 */
		this._cameraNear = reference( 'near', 'float', camera );

		/**
		 * Represents the far value of the scene's camera.
		 *
		 * @private
		 * @type {ReferenceNode<float>}
		 */
		this._cameraFar = reference( 'far', 'float', camera );

		/**
		 * Whether the scene's camera is perspective or orthographic.
		 *
		 * @private
		 * @type {UniformNode<bool>}
		 */
		this._isPerspectiveCamera = uniform( camera.isPerspectiveCamera === true );

		/**
		 * The resolution of the pass.
		 *
		 * @private
		 * @type {UniformNode<vec2>}
		 */
		this._resolution = uniform( new Vector2() );

		/**
		 * The render target the SSR is rendered into.
		 *
		 * @private
		 * @type {RenderTarget}
		 */
		this._ssrRenderTarget = new RenderTarget( 1, 1, { depthBuffer: false, type: HalfFloatType } );
		this._ssrRenderTarget.texture.name = 'SSRNode.SSR';

		/**
		 * The render target for the blurred SSR reflections.
		 *
		 * @private
		 * @type {RenderTarget}
		 */
		this._blurRenderTarget = new RenderTarget( 1, 1, { depthBuffer: false, type: HalfFloatType, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter } );
		this._blurRenderTarget.texture.name = 'SSRNode.Blur';
		this._blurRenderTarget.texture.mipmaps.push( {}, {}, {}, {}, {} );

		/**
		 * The material that is used to render the effect.
		 *
		 * @private
		 * @type {NodeMaterial}
		 */
		this._ssrMaterial = new NodeMaterial();
		this._ssrMaterial.name = 'SSRNode.SSR';

		/**
		 * The blur material.
		 *
		 * @private
		 * @type {NodeMaterial}
		 */
		this._blurMaterial = new NodeMaterial();
		this._blurMaterial.name = 'SSRNode.Blur';

		/**
		 * The copy material.
		 *
		 * @private
		 * @type {NodeMaterial}
		 */
		this._copyMaterial = new NodeMaterial();
		this._copyMaterial.name = 'SSRNode.Copy';

		/**
		 * The result of the effect is represented as a separate texture node.
		 *
		 * @private
		 * @type {PassTextureNode}
		 */
		this._textureNode = passTexture( this, this._ssrRenderTarget.texture );

		let blurredTextureNode = null;

		if ( this.roughnessNode !== null ) {

			const mips = this._blurRenderTarget.texture.mipmaps.length - 1;
			const r = float( this.roughnessNode );
			const lod = r.mul( r ).mul( mips ).mul( this.roughnessBlurScale ).clamp( 0, mips );

			blurredTextureNode = passTexture( this, this._blurRenderTarget.texture ).level( lod );

		}

		/**
		 * Holds the blurred SSR reflections.
		 *
		 * @private
		 * @type {?PassTextureNode}
		 */
		this._blurredTextureNode = blurredTextureNode;

	}

	/**
	 * Returns the result of the effect as a texture node.
	 *
	 * @return {PassTextureNode} A texture node that represents the result of the effect.
	 */
	getTextureNode() {

		return this.roughnessNode !== null ? this._blurredTextureNode : this._textureNode;

	}

	/**
	 * Sets the size of the effect.
	 *
	 * @param {number} width - The width of the effect.
	 * @param {number} height - The height of the effect.
	 */
	setSize( width, height ) {

		width = Math.round( this.resolutionScale * width );
		height = Math.round( this.resolutionScale * height );

		this._resolution.value.set( width, height );
		this._ssrRenderTarget.setSize( width, height );
		this._blurRenderTarget.setSize( width, height );

	}

	/**
	 * This method is used to render the effect once per frame.
	 *
	 * @param {NodeFrame} frame - The current node frame.
	 */
	updateBefore( frame ) {

		const { renderer } = frame;

		_rendererState = RendererUtils.resetRendererState( renderer, _rendererState );

		const ssrRenderTarget = this._ssrRenderTarget;
		const blurRenderTarget = this._blurRenderTarget;

		const size = renderer.getDrawingBufferSize( _size );

		_quadMesh.material = this._ssrMaterial;

		this.setSize( size.width, size.height );

		// clear

		renderer.setMRT( null );
		renderer.setClearColor( 0x000000, 0 );

		// ssr

		renderer.setRenderTarget( ssrRenderTarget );
		_quadMesh.name = 'SSR [ Reflections ]';
		_quadMesh.render( renderer );

		// blur (optional)

		if ( this.roughnessNode !== null ) {

			// blur mips but leave the base mip unblurred

			for ( let i = 0; i < blurRenderTarget.texture.mipmaps.length; i ++ ) {

				_quadMesh.material = ( i === 0 ) ? this._copyMaterial : this._blurMaterial;

				this._blurSpread.value = i;
				renderer.setRenderTarget( blurRenderTarget, 0, i );
				_quadMesh.name = 'SSR [ Blur Level ' + i + ' ]';
				_quadMesh.render( renderer );

			}

		}

		// restore

		RendererUtils.restoreRendererState( renderer, _rendererState );

	}

	/**
	 * This method is used to setup the effect's TSL code.
	 *
	 * @param {NodeBuilder} builder - The current node builder.
	 * @return {PassTextureNode}
	 */
	setup( builder ) {

		const uvNode = uv();

		const pointToLineDistance = Fn( ( [ point, linePointA, linePointB ] )=> {

			// https://mathworld.wolfram.com/Point-LineDistance3-Dimensional.html

			return cross( point.sub( linePointA ), point.sub( linePointB ) ).length().div( linePointB.sub( linePointA ).length() );

		} );

		const pointPlaneDistance = Fn( ( [ point, planePoint, planeNormal ] )=> {

			// https://mathworld.wolfram.com/Point-PlaneDistance.html
			// https://en.wikipedia.org/wiki/Plane_(geometry)
			// http://paulbourke.net/geometry/pointlineplane/

			// planeNormal is already normalized, so denominator is 1
			const d = mul( planeNormal.x, planePoint.x ).add( mul( planeNormal.y, planePoint.y ) ).add( mul( planeNormal.z, planePoint.z ) ).negate().toVar();
			const distance = mul( planeNormal.x, point.x ).add( mul( planeNormal.y, point.y ) ).add( mul( planeNormal.z, point.z ) ).add( d );
			return distance;

		} );

		const getViewZ = Fn( ( [ depth ] ) => {

			let viewZNode;

			if ( this.camera.isPerspectiveCamera ) {

				viewZNode = perspectiveDepthToViewZ( depth, this._cameraNear, this._cameraFar );

			} else {

				viewZNode = orthographicDepthToViewZ( depth, this._cameraNear, this._cameraFar );

			}

			return viewZNode;

		} );

		const sampleDepth = ( uv ) => {

			const depth = this.depthNode.sample( uv ).r;

			if ( builder.renderer.logarithmicDepthBuffer === true ) {

				const viewZ = logarithmicDepthToViewZ( depth, this._cameraNear, this._cameraFar );

				return viewZToPerspectiveDepth( viewZ, this._cameraNear, this._cameraFar );

			}

			return depth;

		};

		// A nearest-only depth field is a staircase at grazing angles. Use both
		// nearest and bilinear depth, as in Tomasz Stachowiak's depth-ray marcher:
		// https://gist.github.com/h3r2tic/9c8356bdaefbe80b1a22ae0aaee192db
		// Their farther value finds a continuous crossing; the nearer value
		// rejects interpolation across unrelated foreground/background surfaces.
		const depthRange = Fn( ( [ coord ] ) => {
			const pixel = coord.mul( this._resolution ).sub( 0.5 ).toVar();
			const base = pixel.floor().toVar();
			const f = pixel.fract().toVar();
			const at = offset => sampleDepth( base.add( offset ).add( 0.5 ).div( this._resolution ) );
			const d00 = at( vec2( 0, 0 ) ).toVar();
			const d10 = at( vec2( 1, 0 ) ).toVar();
			const d01 = at( vec2( 0, 1 ) ).toVar();
			const d11 = at( vec2( 1, 1 ) ).toVar();
			const linear = getViewZ( mix( mix( d00, d10, f.x ), mix( d01, d11, f.x ), f.y ) ).negate();
			const nearest = getViewZ( sampleDepth( coord ) ).negate();
			return vec2( min( nearest, linear ), max( nearest, linear ) );
		} );

		const ssr = Fn( () => {

			const metalness = float( this.metalnessNode );
			const specularResponse = this.specularResponseNode !== null
				? this.specularResponseNode.sample( uvNode ).rgb
				: null;
			const receiverMask = specularResponse !== null
				? max( max( specularResponse.r, specularResponse.g ), specularResponse.b )
				: metalness;

			// Skip pixels without a supported reflective receiver. The PBR path
			// includes dielectric F0, so it is intentionally not metal-only.
			receiverMask.lessThanEqual( 0.00001 ).discard();
			if ( this.roughnessNode !== null ) {
				float( this.roughnessNode ).greaterThanEqual( this.maxRoughness ).discard();
			}

			// compute some standard FX entities
			const depth = sampleDepth( uvNode ).toVar();
			depth.greaterThanEqual( 0.999999 ).discard();
			const viewPosition = getViewPosition( uvNode, depth, this._cameraProjectionMatrixInverse ).toVar();
			const viewNormal = this.normalNode.rgb.normalize().toVar();
			const receiverId = this.objectIdNode !== null
				? this.objectIdNode.sample( uvNode ).toVar() : null;
			// Depth derivatives describe the actual receiving surface. A mapped
			// normal may point into that surface, especially on engraved metals;
			// using it as the hit plane accepts neighbouring pixels of the same
			// object and makes the sky/local boundary crawl as the object rotates.
			const receiverDx = viewPosition.dFdx().toVar();
			const receiverDy = viewPosition.dFdy().toVar();
			const receiverPlane = normalize( cross( receiverDx, receiverDy ) ).toVar();
			If( dot( receiverPlane, viewPosition ).greaterThan( 0 ), () => {
				receiverPlane.mulAssign( - 1 );
			} );
			const minHitSeparation = max( this.thickness.mul( 0.25 ), max( receiverDx.length(), receiverDy.length() ).mul( 0.5 ) ).toVar();

			// compute the direction from the position in view space to the camera
			const viewIncidentDir = ( ( this.camera.isPerspectiveCamera ) ? normalize( viewPosition ) : vec3( 0, 0, - 1 ) ).toVar();

			// compute the direction in which the light is reflected on the surface
			const viewReflectDir = reflect( viewIncidentDir, viewNormal ).toVar();
			// A normal-map ray below the real surface has no resolvable outgoing
			// screen-space path. Let the material's filtered environment handle it.
			dot( viewReflectDir, receiverPlane ).lessThanEqual( 0.001 ).discard();

			// adapt maximum distance to the local geometry (see https://www.mathsisfun.com/algebra/vectors-dot-product.html)
			const maxReflectRayLen = this.maxDistance.div( max( dot( viewIncidentDir.negate(), viewNormal ), 0.05 ) ).toVar();

			// compute the maximum point of the reflection ray in view space
			const d1viewPosition = viewPosition.add( viewReflectDir.mul( maxReflectRayLen ) ).toVar();

			// check if d1viewPosition lies behind the camera near plane
			If( this._isPerspectiveCamera.and( d1viewPosition.z.greaterThan( this._cameraNear.negate() ) ), () => {

				// if so, ensure d1viewPosition is clamped on the near plane.
				// this prevents artifacts during the ray marching process
				const t = sub( this._cameraNear.negate(), viewPosition.z ).div( viewReflectDir.z );
				d1viewPosition.assign( viewPosition.add( viewReflectDir.mul( t ) ) );

			} );

			// d0 and d1 are the start and maximum points of the reflection ray in screen space
			const d0 = screenCoordinate.xy.toVar();
			const d1 = getScreenPosition( d1viewPosition, this._cameraProjectionMatrix ).mul( this._resolution ).toVar();

			const delta = d1.sub( d0 ).toVar();
			const rayPixels = max( abs( delta.x ), abs( delta.y ) ).toVar();
			rayPixels.lessThan( 1 ).discard();
			// Clip the march to the viewport before distributing samples. A ray
			// clipped at the camera near plane can otherwise be millions of pixels.
			const endS = float( 1 ).toVar();
			for ( const axis of [ 'x', 'y' ] ) {
				If( delta[ axis ].greaterThan( 0.00001 ), () => {
					endS.assign( min( endS, this._resolution[ axis ].sub( d0[ axis ] ).sub( 1 ).div( delta[ axis ] ) ) );
				} ).ElseIf( delta[ axis ].lessThan( - 0.00001 ), () => {
					endS.assign( min( endS, d0[ axis ].sub( 1 ).negate().div( delta[ axis ] ) ) );
				} );
			}
			endS.lessThanEqual( 0 ).discard();
			const totalStep = int( rayPixels.mul( endS ).mul( this.quality.clamp() ).ceil().clamp( 1, 128 ) ).toConst();
			const invZ0 = viewPosition.z.reciprocal().toConst();
			const invZ1 = d1viewPosition.z.reciprocal().toConst();
			const rayZAt = this.camera.isPerspectiveCamera
				? s => mix( invZ0, invZ1, s ).reciprocal().negate()
				: s => mix( viewPosition.z, d1viewPosition.z, s ).negate();
			const uvAt = s => d0.add( delta.mul( s ) ).div( this._resolution );
			const bias = max( viewPosition.z.abs().mul( 0.000002 ), 0.0002 ).toVar();
			const previousS = float( 0 ).toVar();
			const lo = float( 0 ).toVar();
			const hi = float( 0 ).toVar();
			const found = bool( false ).toVar();
			const output = vec4( 0 ).toVar();
			const isSelf = coord => receiverId !== null
				? receiverId.greaterThan( 1.5 ).and( abs( this.objectIdNode.sample( coord ).sub( receiverId ) ).lessThan( 0.25 ) )
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
				const hitPosition = getViewPosition( coord, hitDepth, this._cameraProjectionMatrixInverse ).toVar();
				const separation = hitPosition.sub( viewPosition ).toVar();
				// Stop at the first surface even if its crossing cannot be resolved.
				// Marching through rejected occluders leaks unrelated objects into SSR.
				If( penetration.lessThanEqual( this.thickness )
					.and( hitDepth.lessThan( 0.999999 ) )
					.and( dot( separation, receiverPlane ).greaterThan( minHitSeparation ) ), () => {
					// Test geometric orientation, not the hit's normal map. Bump
					// normals describe shading and cannot punch holes in an occluder.
					const dx = vec2( 1, 0 ).div( this._resolution );
					const dy = vec2( 0, 1 ).div( this._resolution );
					const at = uv => getViewPosition( uv, sampleDepth( uv ), this._cameraProjectionMatrixInverse );
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
						const color = this.colorNode.sample( coord ).rgb;
						if ( specularResponse !== null ) {
							// Visibility becomes unknown as the HIT leaves the frame.
							// Fading the receiving pixel instead left hard frustum edges
							// imprinted on curved, normal-mapped objects as dark patches.
							const border = min( min( coord.x, coord.y ), min( coord.x.oneMinus(), coord.y.oneMinus() ) );
							const confidence = border.smoothstep( 0.005, 0.09 );
							output.assign( vec4( color.mul( confidence ), confidence ) );
						} else {
							const distance = pointPlaneDistance( hitPosition, viewPosition, viewNormal );
							const attenuation = distance.div( this.maxDistance ).oneMinus().clamp().pow( 2 );
							const fresnel = dot( viewIncidentDir, viewReflectDir ).add( 1 ).mul( 0.5 );
							output.assign( vec4( color.mul( this.opacity ).mul( metalness ).mul( attenuation ).mul( fresnel ), 1 ) );
						}
					} );
				} );
			} );

			return output;

		} );

		this._ssrMaterial.fragmentNode = ssr().context( builder.getSharedContext() );
		this._ssrMaterial.needsUpdate = true;

		// below materials are used for blurring

		const reflectionBuffer = texture( this._ssrRenderTarget.texture );

		this._blurMaterial.fragmentNode = boxBlur( reflectionBuffer, { size: this.blurQuality, separation: this._blurSpread } );
		this._blurMaterial.needsUpdate = true;

		this._copyMaterial.fragmentNode = reflectionBuffer;
		this._copyMaterial.needsUpdate = true;

		//

		return this.getTextureNode();

	}

	/**
	 * Frees internal resources. This method should be called
	 * when the effect is no longer required.
	 */
	dispose() {

		this._ssrRenderTarget.dispose();
		this._blurRenderTarget.dispose();

		this._ssrMaterial.dispose();
		this._blurMaterial.dispose();
		this._copyMaterial.dispose();

	}

}

export default SSRNode;

/**
 * TSL function for creating screen space reflections (SSR).
 *
 * @tsl
 * @function
 * @param {Node<vec4>} colorNode - The node that represents the beauty pass.
 * @param {Node<float>} depthNode - A node that represents the beauty pass's depth.
 * @param {Node<vec3>} normalNode - A node that represents the beauty pass's normals.
 * @param {Node<float>} metalnessNode - A node that represents the beauty pass's metalness.
 * @param {?Node<float>} [roughnessNode=null] - A node that represents the beauty pass's roughness.
 * @param {?Camera} [camera=null] - The camera the scene is rendered with.
 * @returns {SSRNode}
 */
export const ssr = ( colorNode, depthNode, normalNode, metalnessNode, roughnessNode = null, camera = null ) => new SSRNode( nodeObject( colorNode ), nodeObject( depthNode ), nodeObject( normalNode ), nodeObject( metalnessNode ), nodeObject( roughnessNode ), camera );
