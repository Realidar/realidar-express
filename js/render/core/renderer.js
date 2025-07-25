// Copyright 2018 The Immersive Web Community Group
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import {CAP, MAT_STATE, RENDER_ORDER, stateToBlendFunc} from './material.js';
import {Node} from './node.js';
import {Program} from './program.js';
import {DataTexture, ExternalTexture, VideoTexture} from './texture.js';
import {mat4, vec3} from '../math/gl-matrix.js';

export const ATTRIB = {
  POSITION: 1,
  NORMAL: 2,
  TANGENT: 3,
  TEXCOORD_0: 4,
  TEXCOORD_1: 5,
  COLOR_0: 6,
};

export const ATTRIB_MASK = {
  POSITION: 0x0001,
  NORMAL: 0x0002,
  TANGENT: 0x0004,
  TEXCOORD_0: 0x0008,
  TEXCOORD_1: 0x0010,
  COLOR_0: 0x0020,
};

const GL = WebGLRenderingContext; // For enums

const DEF_LIGHT_DIR = new Float32Array([-0.1, -1.0, -0.2]);
const DEF_LIGHT_COLOR = new Float32Array([3.0, 3.0, 3.0]);

const PRECISION_REGEX = new RegExp('precision (lowp|mediump|highp) float;');

const VERTEX_SHADER_ENTRY = `
uniform mat4 PROJECTION_MATRIX, VIEW_MATRIX, MODEL_MATRIX;

void main() {
  gl_Position = vertex_main(PROJECTION_MATRIX, VIEW_MATRIX, MODEL_MATRIX);
}
`;

const VERTEX_SHADER_MULTI_ENTRY = `
uniform mat4 LEFT_PROJECTION_MATRIX, LEFT_VIEW_MATRIX, RIGHT_PROJECTION_MATRIX, RIGHT_VIEW_MATRIX, MODEL_MATRIX;
void main() {
  gl_Position = vertex_main(
    (gl_ViewID_OVR == 0u) ? LEFT_PROJECTION_MATRIX : RIGHT_PROJECTION_MATRIX,
    (gl_ViewID_OVR == 0u) ? LEFT_VIEW_MATRIX : RIGHT_VIEW_MATRIX,
    MODEL_MATRIX);
}
`;

const FRAGMENT_SHADER_ENTRY = `
out vec4 color;
void main() {
  color = fragment_main();
}
`;

const FRAGMENT_SHADER_MULTI_ENTRY = `
out vec4 color;
void main() {
  color = fragment_main();
}
`;

const VERTEX_SHADER_MULTI_DEPTH_ENTRY = `
uniform mat4 LEFT_PROJECTION_MATRIX, LEFT_VIEW_MATRIX, RIGHT_PROJECTION_MATRIX, RIGHT_VIEW_MATRIX, MODEL_MATRIX;
out vec4 vWorldPosition;

const mat4 identity = mat4(
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1);

void main() {
  vWorldPosition = vertex_main(identity, identity, MODEL_MATRIX);
  gl_Position = vertex_main(
    (gl_ViewID_OVR == 0u) ? LEFT_PROJECTION_MATRIX : RIGHT_PROJECTION_MATRIX,
    (gl_ViewID_OVR == 0u) ? LEFT_VIEW_MATRIX : RIGHT_VIEW_MATRIX,
    MODEL_MATRIX);
}
`;

const VERTEX_SHADER_DEPTH_ENTRY = `
uniform mat4 PROJECTION_MATRIX, VIEW_MATRIX, MODEL_MATRIX;
out vec4 vWorldPosition;

const mat4 identity = mat4(
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1);

void main() {
  vWorldPosition = vertex_main(identity, identity, MODEL_MATRIX);
  gl_Position = vertex_main(PROJECTION_MATRIX, VIEW_MATRIX, MODEL_MATRIX);
}
`;

const FRAGMENT_SHADER_DEPTH_COMMON = `
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray depthColor;
uniform float rawValueToMeters;
out vec4 color;
in vec4 vWorldPosition;
uniform bool sortDepth;

uniform mat4 LEFT_DEPTH_PROJECTION_MATRIX, LEFT_DEPTH_VIEW_MATRIX, RIGHT_DEPTH_PROJECTION_MATRIX, RIGHT_DEPTH_VIEW_MATRIX;

float Depth_GetCameraDepthInMillimeters(const sampler2DArray depthTexture,
  const vec2 depthUv) {
  return texture(depthColor, vec3(depthUv.x, depthUv.y, VIEW_ID)).r * 1000.0 * rawValueToMeters;
}

float Depth_GetOcclusion(const sampler2DArray depthTexture, const vec2 depthUv, float assetDepthMm) {
  float depthMm = Depth_GetCameraDepthInMillimeters(depthTexture, depthUv);

  // Instead of a hard z-buffer test, allow the asset to fade into the
  // background along a 2 * kDepthTolerancePerMm * assetDepthMm
  // range centered on the background depth.
  const float kDepthTolerancePerMm = 0.01;
  return clamp(1.0 -
    0.5 * (depthMm - assetDepthMm) /
        (kDepthTolerancePerMm * assetDepthMm) +
    0.5, 0.0, 1.0);
}

float Depth_GetBlurredOcclusionAroundUV(const sampler2DArray depthTexture, const vec2 uv, float assetDepthMm) {
  // Kernel used:
  // 0   4   7   4   0
  // 4   16  26  16  4
  // 7   26  41  26  7
  // 4   16  26  16  4
  // 0   4   7   4   0
  const float kKernelTotalWeights = 269.0;
  float sum = 0.0;

  const float kOcclusionBlurAmount = 0.01;
  vec2 blurriness = vec2(kOcclusionBlurAmount /SideBySideMultiplier, kOcclusionBlurAmount /** u_DepthAspectRatio*/);

  float current = 0.0;

  current += Depth_GetOcclusion(depthTexture, uv + vec2(-1.0, -2.0) * blurriness, assetDepthMm);
  current += Depth_GetOcclusion(depthTexture, uv + vec2(+1.0, -2.0) * blurriness, assetDepthMm);
  current += Depth_GetOcclusion(depthTexture, uv + vec2(-1.0, +2.0) * blurriness, assetDepthMm);
  current += Depth_GetOcclusion(depthTexture, uv + vec2(+1.0, +2.0) * blurriness, assetDepthMm);
  current += Depth_GetOcclusion(depthTexture, uv + vec2(-2.0, +1.0) * blurriness, assetDepthMm);
  current += Depth_GetOcclusion(depthTexture, uv + vec2(+2.0, +1.0) * blurriness, assetDepthMm);
  current += Depth_GetOcclusion(depthTexture, uv + vec2(-2.0, -1.0) * blurriness, assetDepthMm);
  current += Depth_GetOcclusion(depthTexture, uv + vec2(+2.0, -1.0) * blurriness, assetDepthMm);
  sum += current * 4.0;

  current = 0.0;
  current += Depth_GetOcclusion(depthTexture, uv + vec2(-2.0, -0.0) * blurriness, assetDepthMm);
  current += Depth_GetOcclusion(depthTexture, uv + vec2(+2.0, +0.0) * blurriness, assetDepthMm);
  current += Depth_GetOcclusion(depthTexture, uv + vec2(+0.0, +2.0) * blurriness, assetDepthMm);
  current += Depth_GetOcclusion(depthTexture, uv + vec2(-0.0, -2.0) * blurriness, assetDepthMm);
  sum += current * 7.0;

  current = 0.0;
  current += Depth_GetOcclusion(depthTexture, uv + vec2(-1.0, -1.0) * blurriness, assetDepthMm);
  current += Depth_GetOcclusion(depthTexture, uv + vec2(+1.0, -1.0) * blurriness, assetDepthMm);
  current += Depth_GetOcclusion(depthTexture, uv + vec2(-1.0, +1.0) * blurriness, assetDepthMm);
  current += Depth_GetOcclusion(depthTexture, uv + vec2(+1.0, +1.0) * blurriness, assetDepthMm);
  sum += current * 16.0;

  current = 0.0;
  current += Depth_GetOcclusion(depthTexture, uv + vec2(+0.0, +1.0) * blurriness, assetDepthMm);
  current += Depth_GetOcclusion(depthTexture, uv + vec2(-0.0, -1.0) * blurriness, assetDepthMm);
  current += Depth_GetOcclusion(depthTexture, uv + vec2(-1.0, -0.0) * blurriness, assetDepthMm);
  current += Depth_GetOcclusion(depthTexture, uv + vec2(+1.0, +0.0) * blurriness, assetDepthMm);
  sum += current * 26.0;

  sum += Depth_GetOcclusion(depthTexture, uv, assetDepthMm) * 41.0;

  return sum / kKernelTotalWeights;
}

void main() {
  vec4 depthPosition = (VIEW_ID == 0u) ? LEFT_DEPTH_PROJECTION_MATRIX * LEFT_DEPTH_VIEW_MATRIX * vWorldPosition :
                      RIGHT_DEPTH_PROJECTION_MATRIX * RIGHT_DEPTH_VIEW_MATRIX * vWorldPosition;
  vec2 depthPositionHC = depthPosition.xy / depthPosition.w;
  depthPositionHC = vec2 (depthPositionHC.x + 1.0,  depthPositionHC.y + 1.0 ) * 0.5;
  color = fragment_main();
  if (color.a == 0.0) {
    // There's no sense in calculating occlusion for a fully transparent pixel.
    return;
  }

  if (!sortDepth) {
    return;
  }

  float assetDepthMm = gl_FragCoord.z * 1000.0 * rawValueToMeters;

  float occlusion = Depth_GetBlurredOcclusionAroundUV(depthColor, depthPositionHC, assetDepthMm);

  //float occlusion = Depth_GetOcclusion(depthColor, depthPositionHC, assetDepthMm);

  float objectMaskEroded = pow(occlusion, 10.0);

  float occlusionTransition = clamp(occlusion * (2.0 - objectMaskEroded), 0.0, 1.0);

  float kMaxOcclusion = 1.0;
  occlusionTransition = min(occlusionTransition, kMaxOcclusion);

  color = color * (1.0 - occlusion);
}
`;

const FRAGMENT_SHADER_MULTI_DEPTH_ENTRY = `
#define VIEW_ID gl_ViewID_OVR
#define SideBySideMultiplier 1.0
` + FRAGMENT_SHADER_DEPTH_COMMON;


const FRAGMENT_SHADER_DEPTH_ENTRY = `
uniform uint VIEW_ID;
#define SideBySideMultiplier 1.0
` + FRAGMENT_SHADER_DEPTH_COMMON;

function isPowerOfTwo(n) {
  return (n & (n - 1)) === 0;
}

// Creates a WebGL context and initializes it with some common default state.
export function createWebGLContext(glAttribs) {
  glAttribs = glAttribs || {alpha: false};

  let webglCanvas = document.createElement('canvas');
  let contextTypes = ['webgl2'];
  let context = null;

  for (let contextType of contextTypes) {
    context = webglCanvas.getContext(contextType, glAttribs);
    if (context) {
      break;
    }
  }

  if (!context) {
    let webglType = (glAttribs.webgl2 ? 'WebGL 2' : 'WebGL');
    console.error('This browser does not support ' + webglType + '.');
    return null;
  }

  return context;
}

export class RenderView {
  constructor(projectionMatrix, viewTransform, viewport = null, eye = 'left', depthdata = null) {
    this.projectionMatrix = projectionMatrix;
    this.viewport = viewport;
    // If an eye isn't given the left eye is assumed.
    this._eye = eye;
    this._eyeIndex = (eye == 'left' ? 0 : 1);
    this.depthdata = depthdata;

    // Compute the view matrix
    if (viewTransform instanceof Float32Array) {
      this._viewMatrix = mat4.clone(viewTransform);
      this.viewTransform = new XRRigidTransform(); // TODO
    } else {
      this.viewTransform = viewTransform;
      this._viewMatrix = viewTransform.inverse.matrix;

      // Alternative view matrix code path
      /*this._viewMatrix = mat4.create();
      let q = viewTransform.orientation;
      let t = viewTransform.position;
      mat4.fromRotationTranslation(
          this._viewMatrix,
          [q.x, q.y, q.z, q.w],
          [t.x, t.y, t.z]
      );
      mat4.invert(this._viewMatrix, this._viewMatrix);*/
    }
  }

  get viewMatrix() {
    return this._viewMatrix;
  }

  get eye() {
    return this._eye;
  }

  set eye(value) {
    this._eye = value;
    this._eyeIndex = (value == 'left' ? 0 : 1);
  }

  get eyeIndex() {
    return this._eyeIndex;
  }

  set depthTexture(value) {
     this._depthTexture = value;
  }
}

class RenderBuffer {
  constructor(target, usage, buffer, length = 0) {
    this._target = target;
    this._usage = usage;
    this._length = length;
    if (buffer instanceof Promise) {
      this._buffer = null;
      this._promise = buffer.then((buffer) => {
        this._buffer = buffer;
        return this;
      });
    } else {
      this._buffer = buffer;
      this._promise = Promise.resolve(this);
    }
  }

  waitForComplete() {
    return this._promise;
  }
}

class RenderPrimitiveAttribute {
  constructor(primitiveAttribute) {
    this._attrib_index = ATTRIB[primitiveAttribute.name];
    this._componentCount = primitiveAttribute.componentCount;
    this._componentType = primitiveAttribute.componentType;
    this._stride = primitiveAttribute.stride;
    this._byteOffset = primitiveAttribute.byteOffset;
    this._normalized = primitiveAttribute.normalized;
  }
}

class RenderPrimitiveAttributeBuffer {
  constructor(buffer) {
    this._buffer = buffer;
    this._attributes = [];
  }
}

class RenderPrimitive {
  constructor(primitive) {
    this._activeFrameId = 0;
    this._instances = [];
    this._material = null;

    this.setPrimitive(primitive);
  }

  setPrimitive(primitive) {
    this._mode = primitive.mode;
    this._elementCount = primitive.elementCount;
    this._promise = null;
    this._vao = null;
    this._complete = false;
    this._attributeBuffers = [];
    this._attributeMask = 0;

    for (let attribute of primitive.attributes) {
      this._attributeMask |= ATTRIB_MASK[attribute.name];
      let renderAttribute = new RenderPrimitiveAttribute(attribute);
      let foundBuffer = false;
      for (let attributeBuffer of this._attributeBuffers) {
        if (attributeBuffer._buffer == attribute.buffer) {
          attributeBuffer._attributes.push(renderAttribute);
          foundBuffer = true;
          break;
        }
      }
      if (!foundBuffer) {
        let attributeBuffer = new RenderPrimitiveAttributeBuffer(attribute.buffer);
        attributeBuffer._attributes.push(renderAttribute);
        this._attributeBuffers.push(attributeBuffer);
      }
    }

    this._indexBuffer = null;
    this._indexByteOffset = 0;
    this._indexType = 0;

    if (primitive.indexBuffer) {
      this._indexByteOffset = primitive.indexByteOffset;
      this._indexType = primitive.indexType;
      this._indexBuffer = primitive.indexBuffer;
    }

    if (primitive._min) {
      this._min = vec3.clone(primitive._min);
      this._max = vec3.clone(primitive._max);
    } else {
      this._min = null;
      this._max = null;
    }

    if (this._material != null) {
      this.waitForComplete(); // To flip the _complete flag.
    }
  }

  setRenderMaterial(material) {
    this._material = material;
    this._promise = null;
    this._complete = false;

    if (this._material != null) {
      this.waitForComplete(); // To flip the _complete flag.
    }
  }

  markActive(frameId) {
    if (this._complete && this._activeFrameId != frameId) {
      if (this._material) {
        if (!this._material.markActive(frameId)) {
          return;
        }
      }
      this._activeFrameId = frameId;
    }
  }

  get samplers() {
    return this._material._samplerDictionary;
  }

  get uniforms() {
    return this._material._uniform_dictionary;
  }

  waitForComplete() {
    if (!this._promise) {
      if (!this._material) {
        return Promise.reject('RenderPrimitive does not have a material');
      }

      let completionPromises = [];

      for (let attributeBuffer of this._attributeBuffers) {
        if (!attributeBuffer._buffer._buffer) {
          completionPromises.push(attributeBuffer._buffer._promise);
        }
      }

      if (this._indexBuffer && !this._indexBuffer._buffer) {
        completionPromises.push(this._indexBuffer._promise);
      }

      this._promise = Promise.all(completionPromises).then(() => {
        this._complete = true;
        return this;
      });
    }
    return this._promise;
  }
}

export class RenderTexture {
  constructor(texture) {
    this._texture = texture;
    this._complete = false;
    this._activeFrameId = 0;
    this._activeCallback = null;
    this._isExternalTexture = false;
    this._isArray = false;
  }

  markActive(frameId) {
    if (this._activeCallback && this._activeFrameId != frameId) {
      this._activeFrameId = frameId;
      this._activeCallback(this);
    }
  }
}

const inverseMatrix = mat4.create();

function setCap(gl, glEnum, cap, prevState, state) {
  let change = (state & cap) - (prevState & cap);
  if (!change) {
    return;
  }

  if (change > 0) {
    gl.enable(glEnum);
  } else {
    gl.disable(glEnum);
  }
}

class RenderMaterialSampler {
  constructor(renderer, materialSampler, index) {
    this._renderer = renderer;
    this._uniformName = materialSampler._uniformName;
    this._renderTexture = renderer._getRenderTexture(materialSampler._texture);
    this._index = index;
  }

  set texture(value) {
    this._renderTexture = this._renderer._getRenderTexture(value);
  }
}

class RenderMaterialUniform {
  constructor(materialUniform) {
    this._uniformName = materialUniform._uniformName;
    this._uniform = null;
    this._length = materialUniform._length;
    if (materialUniform._value instanceof Array) {
      this._value = new Float32Array(materialUniform._value);
    } else {
      this._value = new Float32Array([materialUniform._value]);
    }
  }

  set value(value) {
    if (this._value.length == 1) {
      this._value[0] = value;
    } else {
      for (let i = 0; i < this._value.length; ++i) {
        this._value[i] = value[i];
      }
    }
  }
}

class RenderMaterial {
  constructor(renderer, material, program) {
    this._program = program;
    this._state = material.state._state;
    this._activeFrameId = 0;
    this._completeForActiveFrame = false;

    this._samplerDictionary = {};
    this._samplers = [];
    for (let i = 0; i < material._samplers.length; ++i) {
      let renderSampler = new RenderMaterialSampler(renderer, material._samplers[i], i);
      this._samplers.push(renderSampler);
      this._samplerDictionary[renderSampler._uniformName] = renderSampler;
    }

    this._uniform_dictionary = {};
    this._uniforms = [];
    for (let uniform of material._uniforms) {
      let renderUniform = new RenderMaterialUniform(uniform);
      this._uniforms.push(renderUniform);
      this._uniform_dictionary[renderUniform._uniformName] = renderUniform;
    }

    this._firstBind = true;

    this._renderOrder = material.renderOrder;
    if (this._renderOrder == RENDER_ORDER.DEFAULT) {
      if (this._state & CAP.BLEND) {
        this._renderOrder = RENDER_ORDER.TRANSPARENT;
      } else {
        this._renderOrder = RENDER_ORDER.OPAQUE;
      }
    }
  }

  bind(gl) {
    // First time we do a binding, cache the uniform locations and remove
    // unused uniforms from the list.
    if (this._firstBind) {
      for (let i = 0; i < this._samplers.length;) {
        let sampler = this._samplers[i];
        if (!this._program.uniform[sampler._uniformName]) {
          this._samplers.splice(i, 1);
          continue;
        }
        ++i;
      }

      for (let i = 0; i < this._uniforms.length;) {
        let uniform = this._uniforms[i];
        uniform._uniform = this._program.uniform[uniform._uniformName];
        if (!uniform._uniform) {
          this._uniforms.splice(i, 1);
          continue;
        }
        ++i;
      }
      this._firstBind = false;
    }

    for (let sampler of this._samplers) {
      let type = sampler._renderTexture._isArray ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D;

      gl.activeTexture(gl.TEXTURE0 + sampler._index);
      if (sampler._renderTexture && sampler._renderTexture._complete) {
        gl.bindTexture(type, sampler._renderTexture._texture);
      } else {
        gl.bindTexture(type, null);
      }
    }

    for (let uniform of this._uniforms) {
      switch (uniform._length) {
        case 1: gl.uniform1fv(uniform._uniform, uniform._value); break;
        case 2: gl.uniform2fv(uniform._uniform, uniform._value); break;
        case 3: gl.uniform3fv(uniform._uniform, uniform._value); break;
        case 4: gl.uniform4fv(uniform._uniform, uniform._value); break;
      }
    }
  }

  markActive(frameId) {
    if (this._activeFrameId != frameId) {
      this._activeFrameId = frameId;
      this._completeForActiveFrame = true;
      for (let i = 0; i < this._samplers.length; ++i) {
        let sampler = this._samplers[i];
        if (sampler._renderTexture) {
          if (!sampler._renderTexture._complete) {
            this._completeForActiveFrame = false;
            break;
          }
          sampler._renderTexture.markActive(frameId);
        }
      }
    }
    return this._completeForActiveFrame;
  }

  // Material State fetchers
  get cullFace() {
    return !!(this._state & CAP.CULL_FACE);
  }
  get blend() {
    return !!(this._state & CAP.BLEND);
  }
  get depthTest() {
    return !!(this._state & CAP.DEPTH_TEST);
  }
  get stencilTest() {
    return !!(this._state & CAP.STENCIL_TEST);
  }
  get colorMask() {
    return !!(this._state & CAP.COLOR_MASK);
  }
  get depthMask() {
    return !!(this._state & CAP.DEPTH_MASK);
  }
  get stencilMask() {
    return !!(this._state & CAP.STENCIL_MASK);
  }
  get depthFunc() {
    return ((this._state & MAT_STATE.DEPTH_FUNC_RANGE) >> MAT_STATE.DEPTH_FUNC_SHIFT) + GL.NEVER;
  }
  get blendFuncSrc() {
    return stateToBlendFunc(this._state, MAT_STATE.BLEND_SRC_RANGE, MAT_STATE.BLEND_SRC_SHIFT);
  }
  get blendFuncDst() {
    return stateToBlendFunc(this._state, MAT_STATE.BLEND_DST_RANGE, MAT_STATE.BLEND_DST_SHIFT);
  }

  // Only really for use from the renderer
  _capsDiff(otherState) {
    return (otherState & MAT_STATE.CAPS_RANGE) ^ (this._state & MAT_STATE.CAPS_RANGE);
  }

  _blendDiff(otherState) {
    if (!(this._state & CAP.BLEND)) {
      return 0;
    }
    return (otherState & MAT_STATE.BLEND_FUNC_RANGE) ^ (this._state & MAT_STATE.BLEND_FUNC_RANGE);
  }

  _depthFuncDiff(otherState) {
    if (!(this._state & CAP.DEPTH_TEST)) {
      return 0;
    }
    return (otherState & MAT_STATE.DEPTH_FUNC_RANGE) ^ (this._state & MAT_STATE.DEPTH_FUNC_RANGE);
  }
}

export class Renderer {
  constructor(gl, multiview, multisampledMultiview, useDepth) {
    this._gl = gl || createWebGLContext();
    this._frameId = 0;
    this._programCache = {};
    this._textureCache = {};
    this._renderPrimitives = Array(RENDER_ORDER.DEFAULT);
    this._cameraPositions = [];

    this._vaoExt = gl.getExtension('OES_vertex_array_object');

    let fragHighPrecision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    this._defaultFragPrecision = fragHighPrecision.precision > 0 ? 'highp' : 'mediump';

    this._depthMaskNeedsReset = false;
    this._colorMaskNeedsReset = false;

    this._globalLightColor = vec3.clone(DEF_LIGHT_COLOR);
    this._globalLightDir = vec3.clone(DEF_LIGHT_DIR);

    this._mv_ext = gl.getExtension('OVR_multiview2');

    this._multiview = multiview && this._mv_ext;
    this._multisampledMultiview = multisampledMultiview;
    this._useDepth = useDepth;
  }

  get gl() {
    return this._gl;
  }

  get multiview() {
    return this._multiview;
  }

  get multisampledMultiview() {
    return this._multisampledMultiview && this._multiview;
  }

  get multiviewExtension() {
    return this._mv_ext;
  }

  get xrFramebuffer() {
    if (!this._xrFramebuffer) {
      this._xrFramebuffer = this._gl.createFramebuffer();
    }

    return this._xrFramebuffer;
  }

  getXrBinding(session) {
    if (this._xrBindingSession != session) {
      this._xrBinding = new XRWebGLBinding(session, this._gl);
      this._xrBindingSession = session;
    }

    return this._xrBinding;
  }

  get maxSamples() {
    if (!this._maxSamples) {
      this._maxSamples = this._gl.getParameter(this._gl.MAX_SAMPLES);
    }
    return this._maxSamples;
  }

  set globalLightColor(value) {
    vec3.copy(this._globalLightColor, value);
  }

  get globalLightColor() {
    return vec3.clone(this._globalLightColor);
  }

  set globalLightDir(value) {
    vec3.copy(this._globalLightDir, value);
  }

  get globalLightDir() {
    return vec3.clone(this._globalLightDir);
  }

  createRenderBuffer(target, data, usage = GL.STATIC_DRAW) {
    let gl = this._gl;
    let glBuffer = gl.createBuffer();

    if (data instanceof Promise) {
      let renderBuffer = new RenderBuffer(target, usage, data.then((data) => {
        gl.bindBuffer(target, glBuffer);
        gl.bufferData(target, data, usage);
        renderBuffer._length = data.byteLength;
        return glBuffer;
      }));
      return renderBuffer;
    } else {
      gl.bindBuffer(target, glBuffer);
      gl.bufferData(target, data, usage);
      return new RenderBuffer(target, usage, glBuffer, data.byteLength);
    }
  }

  updateRenderBuffer(buffer, data, offset = 0) {
    if (buffer._buffer) {
      let gl = this._gl;
      gl.bindBuffer(buffer._target, buffer._buffer);
      if (offset == 0 && buffer._length == data.byteLength) {
        gl.bufferData(buffer._target, data, buffer._usage);
      } else {
        gl.bufferSubData(buffer._target, offset, data);
      }
    } else {
      buffer.waitForComplete().then((buffer) => {
        this.updateRenderBuffer(buffer, data, offset);
      });
    }
  }

  createRenderPrimitive(primitive, material) {
    let renderPrimitive = new RenderPrimitive(primitive);

    let program = this._getMaterialProgram(material, renderPrimitive);
    let renderMaterial = new RenderMaterial(this, material, program);
    renderPrimitive.setRenderMaterial(renderMaterial);

    if (!this._renderPrimitives[renderMaterial._renderOrder]) {
      this._renderPrimitives[renderMaterial._renderOrder] = [];
    }

    this._renderPrimitives[renderMaterial._renderOrder].push(renderPrimitive);

    return renderPrimitive;
  }

  createMesh(primitive, material) {
    let meshNode = new Node();
    meshNode.addRenderPrimitive(this.createRenderPrimitive(primitive, material));
    return meshNode;
  }

  drawViews(views, rootNode, depthData) {
    if (!rootNode) {
      return;
    }

    let gl = this._gl;
    this._frameId++;

    rootNode.markActive(this._frameId);

    // If there's only one view then flip the algorithm a bit so that we're only
    // setting the viewport once.
    if (views.length == 1 && views[0].viewport) {
      let vp = views[0].viewport;
      this._gl.viewport(vp.x, vp.y, vp.width, vp.height);
    }

    // Get the positions of the 'camera' for each view matrix.
    for (let i = 0; i < views.length; ++i) {
      if (this._cameraPositions.length <= i) {
        this._cameraPositions.push(vec3.create());
      }
      let p = views[i].viewTransform.position;
      this._cameraPositions[i][0] = p.x;
      this._cameraPositions[i][1] = p.y;
      this._cameraPositions[i][2] = p.z;

      /*mat4.invert(inverseMatrix, views[i].viewMatrix);
      let cameraPosition = this._cameraPositions[i];
      vec3.set(cameraPosition, 0, 0, 0);
      vec3.transformMat4(cameraPosition, cameraPosition, inverseMatrix);*/
    }

    // Draw each set of render primitives in order
    for (let renderPrimitives of this._renderPrimitives) {
      if (renderPrimitives && renderPrimitives.length) {
        this._drawRenderPrimitiveSet(views, renderPrimitives, depthData);
      }
    }

    if (this._vaoExt) {
      this._vaoExt.bindVertexArrayOES(null);
    }

    if (this._depthMaskNeedsReset) {
      gl.depthMask(true);
    }
    if (this._colorMaskNeedsReset) {
      gl.colorMask(true, true, true, true);
    }
  }

  _drawRenderPrimitiveSet(views, renderPrimitives, depthData) {
    let gl = this._gl;
    let program = null;
    let material = null;
    let attribMask = 0;

    // Loop through every primitive known to the renderer.
    for (let primitive of renderPrimitives) {
      // Skip over those that haven't been marked as active for this frame.
      if (primitive._activeFrameId != this._frameId) {
        continue;
      }

      // Bind the primitive material's program if it's different than the one we
      // were using for the previous primitive.
      // TODO: The ording of this could be more efficient.
      if (program != primitive._material._program) {
        program = primitive._material._program;
        program.use();

        if (program.uniform.LIGHT_DIRECTION) {
          gl.uniform3fv(program.uniform.LIGHT_DIRECTION, this._globalLightDir);
        }

        if (program.uniform.LIGHT_COLOR) {
          gl.uniform3fv(program.uniform.LIGHT_COLOR, this._globalLightColor);
        }

        if (views.length == 1) {
          gl.uniformMatrix4fv(program.uniform.PROJECTION_MATRIX, false, views[0].projectionMatrix);
          gl.uniformMatrix4fv(program.uniform.VIEW_MATRIX, false, views[0].viewMatrix);
          gl.uniform3fv(program.uniform.CAMERA_POSITION, this._cameraPositions[0]);
          gl.uniform1i(program.uniform.EYE_INDEX, views[0].eyeIndex);
        }
      }

      if (material != primitive._material) {
        this._bindMaterialState(primitive._material, material);
        primitive._material.bind(gl, program, material);
        material = primitive._material;
      }

      if (this._vaoExt) {
        if (primitive._vao) {
          this._vaoExt.bindVertexArrayOES(primitive._vao);
        } else {
          primitive._vao = this._vaoExt.createVertexArrayOES();
          this._vaoExt.bindVertexArrayOES(primitive._vao);
          this._bindPrimitive(primitive);
        }
      } else {
        this._bindPrimitive(primitive, attribMask);
        attribMask = primitive._attributeMask;
      }

      for (let i = 0; i < views.length; ++i) {
        let view = views[i];
        if (views.length > 1) {
          if (view.viewport) {
            let vp = view.viewport;
            gl.viewport(vp.x, vp.y, vp.width, vp.height);
          }
          if (this.multiview) {
            if (i == 0) {
              gl.uniformMatrix4fv(program.uniform.LEFT_PROJECTION_MATRIX, false, views[0].projectionMatrix);
              gl.uniformMatrix4fv(program.uniform.LEFT_VIEW_MATRIX, false, views[0].viewMatrix);
              gl.uniformMatrix4fv(program.uniform.RIGHT_PROJECTION_MATRIX, false, views[1].projectionMatrix);
              gl.uniformMatrix4fv(program.uniform.RIGHT_VIEW_MATRIX, false, views[1].viewMatrix);
            }
            // TODO(AB): modify shaders which use CAMERA_POSITION and EYE_INDEX to work with Multiview
            gl.uniform3fv(program.uniform.CAMERA_POSITION, this._cameraPositions[i]);
            gl.uniform1i(program.uniform.EYE_INDEX, view.eyeIndex);
          } else {
            gl.uniformMatrix4fv(program.uniform.PROJECTION_MATRIX, false, view.projectionMatrix);
            gl.uniformMatrix4fv(program.uniform.VIEW_MATRIX, false, view.viewMatrix);
            gl.uniform3fv(program.uniform.CAMERA_POSITION, this._cameraPositions[i]);
            gl.uniform1i(program.uniform.EYE_INDEX, view.eyeIndex);

            if (depthData && depthData.length) {
              gl.uniform1ui(program.uniform.VIEW_ID, i);
            }
          }
          if (depthData) {
            gl.uniform1i(program.uniform.sortDepth, depthData.length > 0);
          }
          if ((i == 0) && depthData && depthData.length) {
            // for older browser that don't support projectionMatrix and transform on the depth data
            gl.uniformMatrix4fv(program.uniform.LEFT_DEPTH_PROJECTION_MATRIX, false, views[0].projectionMatrix);
            gl.uniformMatrix4fv(program.uniform.LEFT_DEPTH_VIEW_MATRIX, false, views[0].viewMatrix);
            gl.uniformMatrix4fv(program.uniform.RIGHT_DEPTH_PROJECTION_MATRIX, false, views[1].projectionMatrix);
            gl.uniformMatrix4fv(program.uniform.RIGHT_DEPTH_VIEW_MATRIX, false, views[1].viewMatrix);

            gl.uniform1f(program.uniform.rawValueToMeters, depthData[0].rawValueToMeters);

            if (depthData[0].projectionMatrix) {
              gl.uniformMatrix4fv(program.uniform.LEFT_DEPTH_PROJECTION_MATRIX, false, depthData[0].projectionMatrix);
              gl.uniformMatrix4fv(program.uniform.LEFT_DEPTH_VIEW_MATRIX, false, depthData[0].transform.inverse.matrix);
              gl.uniformMatrix4fv(program.uniform.RIGHT_DEPTH_PROJECTION_MATRIX, false, depthData[1].projectionMatrix);
              gl.uniformMatrix4fv(program.uniform.RIGHT_DEPTH_VIEW_MATRIX, false, depthData[1].transform.inverse.matrix);
            }
            // Bind the depth texture to the slot after the material samplers
            gl.activeTexture(gl.TEXTURE0 + material._samplers.length);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, depthData[0].texture);
            gl.uniform1i(program.uniform.depthColor, material._samplers.length);
          }
        }

        for (let instance of primitive._instances) {
          if (instance._activeFrameId != this._frameId) {
            continue;
          }

          gl.uniformMatrix4fv(program.uniform.MODEL_MATRIX, false, instance.worldMatrix);

          if (primitive._indexBuffer) {
            gl.drawElements(primitive._mode, primitive._elementCount,
                primitive._indexType, primitive._indexByteOffset);
          } else {
            gl.drawArrays(primitive._mode, 0, primitive._elementCount);
          }
        }
        if (this.multiview) {
          break;
        }
      }
    }
  }

  addExternalTexture(key, texture, isArray) {
    if (this._textureCache[key] === undefined) {
      this._textureCache[key] = {};
    }
    this._textureCache[key]._complete = true;
    this._textureCache[key]._texture = texture;
    this._textureCache[key]._isArray = isArray;
  }

  _getRenderTexture(texture) {
    if (!texture) {
      return null;
    }

    let key = texture.textureKey;
    if (!key) {
      throw new Error('Texure does not have a valid key');
    }

    if (key in this._textureCache) {
      return this._textureCache[key];
    } else {
      let gl = this._gl;
      let textureHandle = gl.createTexture();

      let renderTexture = new RenderTexture(textureHandle);
      this._textureCache[key] = renderTexture;

      if (texture instanceof ExternalTexture) {
        renderTexture._isExternalTexture = true;
      } else if (texture instanceof DataTexture) {
        gl.bindTexture(gl.TEXTURE_2D, textureHandle);
        gl.texImage2D(gl.TEXTURE_2D, 0, texture.format, texture.width, texture.height,
                                     0, texture.format, texture._type, texture._data);
        this._setSamplerParameters(texture);
        renderTexture._complete = true;
      } else {
        texture.waitForComplete().then(() => {
          gl.bindTexture(gl.TEXTURE_2D, textureHandle);
          gl.texImage2D(gl.TEXTURE_2D, 0, texture.format, texture.format, gl.UNSIGNED_BYTE, texture.source);
          this._setSamplerParameters(texture);
          renderTexture._complete = true;

          if (texture instanceof VideoTexture) {
            // Once the video starts playing, set a callback to update it's
            // contents each frame.
            texture._video.addEventListener('playing', () => {
              renderTexture._activeCallback = () => {
                if (!texture._video.paused && !texture._video.waiting) {
                  gl.bindTexture(gl.TEXTURE_2D, textureHandle);
                  gl.texImage2D(gl.TEXTURE_2D, 0, texture.format, texture.format, gl.UNSIGNED_BYTE, texture.source);
                }
              };
            });
          }
        });
      }

      return renderTexture;
    }
  }

  _setSamplerParameters(texture) {
    let gl = this._gl;

    let sampler = texture.sampler;
    let powerOfTwo = isPowerOfTwo(texture.width) && isPowerOfTwo(texture.height);
    let mipmap = powerOfTwo && texture.mipmap;
    if (mipmap) {
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    let minFilter = sampler.minFilter || (mipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    let wrapS = sampler.wrapS || (powerOfTwo ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    let wrapT = sampler.wrapT || (powerOfTwo ? gl.REPEAT : gl.CLAMP_TO_EDGE);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sampler.magFilter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
  }

  _getProgramKey(name, defines) {
    let key = `${name}:`;

    for (let define in defines) {
      key += `${define}=${defines[define]},`;
    }

    return key;
  }

  _getMaterialProgram(material, renderPrimitive) {
    let materialName = material.materialName;
    material.useDepth = this.useDepth;
    let vertexSource = material.vertexSource;
    let fragmentSource = material.fragmentSource;

    // These should always be defined for every material
    if (materialName == null) {
      throw new Error('Material does not have a name');
    }
    if (vertexSource == null) {
      throw new Error(`Material "${materialName}" does not have a vertex source`);
    }
    if (fragmentSource == null) {
      throw new Error(`Material "${materialName}" does not have a fragment source`);
    }

    let defines = material.getProgramDefines(renderPrimitive);
    let key = this._getProgramKey(materialName, defines);

    let extensions = [];
    let layouts = [];
    if (this.multiview) {
      extensions = ['GL_OVR_multiview2'];
      layouts = ['num_views=2'];
    }

    if (key in this._programCache) {
      return this._programCache[key];
    } else {
      let fullVertexSource = vertexSource;
      if (this._useDepth) {
        fullVertexSource += this.multiview ? VERTEX_SHADER_MULTI_DEPTH_ENTRY : VERTEX_SHADER_DEPTH_ENTRY;
      } else {
        fullVertexSource += this.multiview ? VERTEX_SHADER_MULTI_ENTRY : VERTEX_SHADER_ENTRY;
      }

      let precisionMatch = fragmentSource.match(PRECISION_REGEX);
      let fragPrecisionHeader = precisionMatch ? '' : `precision ${this._defaultFragPrecision} float;\n`;

      let fullFragmentSource = fragPrecisionHeader + fragmentSource;

      if (this._useDepth) {
        fullFragmentSource += this.multiview ? FRAGMENT_SHADER_MULTI_DEPTH_ENTRY : FRAGMENT_SHADER_DEPTH_ENTRY;
      } else {
        fullFragmentSource += this.multiview ? FRAGMENT_SHADER_MULTI_ENTRY : FRAGMENT_SHADER_ENTRY
      }

      let program = new Program(this._gl, fullVertexSource, fullFragmentSource, ATTRIB, defines, extensions, layouts);
      this._programCache[key] = program;

      program.onNextUse((program) => {
        // Bind the samplers to the right texture index. This is constant for
        // the lifetime of the program.
        for (let i = 0; i < material._samplers.length; ++i) {
          let sampler = material._samplers[i];
          let uniform = program.uniform[sampler._uniformName];
          if (uniform) {
            this._gl.uniform1i(uniform, i);
          }
        }
      });

      return program;
    }
  }

  _bindPrimitive(primitive, attribMask) {
    let gl = this._gl;

    // If the active attributes have changed then update the active set.
    if (attribMask != primitive._attributeMask) {
      for (let attrib in ATTRIB) {
        if (primitive._attributeMask & ATTRIB_MASK[attrib]) {
          gl.enableVertexAttribArray(ATTRIB[attrib]);
        } else {
          gl.disableVertexAttribArray(ATTRIB[attrib]);
        }
      }
    }

    // Bind the primitive attributes and indices.
    for (let attributeBuffer of primitive._attributeBuffers) {
      gl.bindBuffer(gl.ARRAY_BUFFER, attributeBuffer._buffer._buffer);
      for (let attrib of attributeBuffer._attributes) {
        gl.vertexAttribPointer(
            attrib._attrib_index, attrib._componentCount, attrib._componentType,
            attrib._normalized, attrib._stride, attrib._byteOffset);
      }
    }

    if (primitive._indexBuffer) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, primitive._indexBuffer._buffer);
    } else {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    }
  }

  _bindMaterialState(material, prevMaterial = null) {
    let gl = this._gl;

    let state = material._state;
    let prevState = prevMaterial ? prevMaterial._state : ~state;

    // Return early if both materials use identical state
    if (state == prevState) {
      return;
    }

    // Any caps bits changed?
    if (material._capsDiff(prevState)) {
      setCap(gl, gl.CULL_FACE, CAP.CULL_FACE, prevState, state);
      setCap(gl, gl.BLEND, CAP.BLEND, prevState, state);
      setCap(gl, gl.DEPTH_TEST, CAP.DEPTH_TEST, prevState, state);
      setCap(gl, gl.STENCIL_TEST, CAP.STENCIL_TEST, prevState, state);

      let colorMaskChange = (state & CAP.COLOR_MASK) - (prevState & CAP.COLOR_MASK);
      if (colorMaskChange) {
        let mask = colorMaskChange > 1;
        this._colorMaskNeedsReset = !mask;
        gl.colorMask(mask, mask, mask, mask);
      }

      let depthMaskChange = (state & CAP.DEPTH_MASK) - (prevState & CAP.DEPTH_MASK);
      if (depthMaskChange) {
        this._depthMaskNeedsReset = !(depthMaskChange > 1);
        gl.depthMask(depthMaskChange > 1);
      }

      let stencilMaskChange = (state & CAP.STENCIL_MASK) - (prevState & CAP.STENCIL_MASK);
      if (stencilMaskChange) {
        gl.stencilMask(stencilMaskChange > 1 ? 0xff : 0x00);
      }
    }

    // Blending enabled and blend func changed?
    if (material._blendDiff(prevState)) {
      gl.blendFunc(material.blendFuncSrc, material.blendFuncDst);
    }

    // Depth testing enabled and depth func changed?
    if (material._depthFuncDiff(prevState)) {
      gl.depthFunc(material.depthFunc);
    }
  }
}