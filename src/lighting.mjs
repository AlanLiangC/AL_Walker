import { streetLamps } from './city.mjs';
import { layoutClass as label, materialStride } from './render-layout.mjs';

const SKY_U_SUN=.612793;
const elevation=.44;
const azimuth=1.08;
export const sun=[Math.cos(elevation)*Math.cos(azimuth),Math.sin(elevation),Math.cos(elevation)*Math.sin(azimuth)];

const PHOTO = `
  uniform bool uPhoto;
  uniform sampler2D uPhotoColor, uPhotoDepth;
  uniform mat4 uPhotoVP;
  const vec3 MM=vec3(255.0, 65280.0, 16711680.0)*.001;
  float insidePhoto(vec2 uv) {
    vec2 edge=min(uv,1.0-uv);
    return smoothstep(.008,.085,min(edge.x,edge.y));
  }
  vec3 projectedColor(vec3 rgb,vec4 clip,bool sky,float amount) {
    if (!uPhoto||clip.w<=.05) return rgb;
    vec2 coord=clip.xy/clip.w*.5+.5;
    float edge=insidePhoto(coord);
    if (edge<=0.0) return rgb;
    float z=dot(texture2D(uPhotoDepth,coord).rgb,MM);
    float tolerance=min(.32,.06+.012*clip.w);
    float visible=sky ? step(z,.002):step(.002,z)*(1.0-smoothstep(tolerance,2.0*tolerance,abs(z-clip.w)));
    return mix(rgb,texture2D(uPhotoColor,vec2(coord.x,1.0-coord.y)).rgb,amount*edge*visible);
  }
`;

const SKY = `
  uniform sampler2D uSky;
  uniform vec3 uSun, uHaze;
  uniform vec4 uWeather;
  uniform float uOvercast;
  uniform bool uNight;
  const float PI=3.14159265;
  vec3 skyColor(vec3 ray) {
    float u=fract(atan(ray.z,ray.x)/(2.0*PI)+${(SKY_U_SUN-azimuth/(2*Math.PI)).toFixed(7)});
    float v=acos(clamp(ray.y,-1.0,1.0))/PI;
    vec3 clouds=texture2D(uSky,vec2(u,min(v,.487))).rgb;
    clouds=pow(max(clouds,0.0),vec3(.86))*vec3(1.03,1.04,1.09);
    vec3 horizon=uHaze+vec3(.06,.025,-.02);
    float horizonBlend=smoothstep(.022,.23,ray.y);
    float sunlight=pow(max(dot(ray,uSun),0.0),24.0);
    vec3 daylight=mix(horizon,clouds,horizonBlend);
    daylight+=vec3(.13,.090,.035)*sunlight;
    vec3 cloudy=mix(uHaze,vec3(.65,.71,.73),horizonBlend);
    cloudy*=.88+.18*dot(clouds,vec3(.33));
    vec3 day=clamp(mix(daylight,cloudy,uOvercast),0.0,1.0);
    if (!uNight) return day;
    return mix(vec3(.11,.15,.21),vec3(.026,.038,.073)+clouds*.06,horizonBlend);
  }
`;

export const skyVertex = `
  attribute vec2 aPoint;
  varying vec2 vScreen;
  void main() {
    vScreen=aPoint;
    gl_Position=vec4(aPoint,0.9998,1.0);
  }
`;

export const skyFragment = `
  precision highp float;
  varying vec2 vScreen;
  uniform vec3 uCameraX, uCameraY, uCameraZ;
  ${SKY}
  ${PHOTO}
  void main() {
    vec3 ray=normalize(uCameraZ+vScreen.x*uCameraX+vScreen.y*uCameraY);
    vec3 sky=projectedColor(skyColor(ray),uPhotoVP*vec4(ray,0.0),true,.94);
    gl_FragColor=vec4(sky,1.0);
  }
`;

export const geometryVertex = `
  attribute vec3 aPoint, aColor, aNormal;
  attribute float aMaterial;
  attribute vec2 aUV;
  uniform mat4 uProjection, uView;
  uniform vec3 uPosition, uScale;
  uniform float uYaw, uTime;
  varying vec3 vColor, vWorld, vNormal;
  varying vec2 vUV;
  varying float vDepth, vMaterial;
  void main() {
    float s=sin(uYaw), c=cos(uYaw);
    vec3 p=aPoint*uScale;
    vec3 n=aNormal/uScale;
    vWorld=uPosition+vec3(c*p.x-s*p.z,p.y,s*p.x+c*p.z);
    if (mod(aMaterial,${materialStride}.0)==11.0) {
      float breeze=sin(uTime*1.8+vWorld.x*.27+vWorld.z*.22);
      vWorld.x+=breeze*.046;
      vWorld.z+=breeze*.025;
    }
    vNormal=vec3(c*n.x-s*n.z,n.y,s*n.x+c*n.z);
    vec4 view=uView*vec4(vWorld,1.0);
    vColor=aColor;
    vDepth=-view.z;
    vMaterial=aMaterial;
    vUV=aUV;
    gl_Position=uProjection*view;
  }
`;

export const geometryFragment = (hasGradient,hasProjection) => `
  ${hasGradient ? '#extension GL_OES_standard_derivatives : enable\n#extension GL_EXT_shader_texture_lod : enable' : ''}
  precision highp float;
  varying vec3 vColor, vWorld, vNormal;
  varying vec2 vUV;
  varying float vDepth, vMaterial;
  uniform vec3 uTint, uEye;
  uniform mat4 uSunVP, uReflectionVP;
  uniform float uShadowTexel, uTime;
  uniform int uPass;
  uniform float uSemantic;
  uniform bool uReflect;
  uniform float uSnow;
  uniform vec3 uLanterns[${streetLamps.length}],uHeadlamp,uAhead;
  uniform sampler2D uAlbedo, uRelief, uLeaves, uSign, uShadow, uReflection;
  ${SKY}
  ${hasProjection?PHOTO:''}

  float hash(vec2 p) {
    vec3 q=fract(vec3(p.xyx)*0.1031);
    q+=dot(q,q.yzx+33.33);
    return fract((q.x+q.y)*q.z);
  }
  float noise(vec2 p) {
    vec2 cell=floor(p), f=fract(p);
    f=f*f*(3.0-2.0*f);
    return mix(mix(hash(cell),hash(cell+vec2(1,0)),f.x),
               mix(hash(cell+vec2(0,1)),hash(cell+1.0),f.x),f.y);
  }
  vec3 encode(float value) {
    return vec3(mod(value,256.0),mod(floor(value/256.0),256.0),floor(value/65536.0))/255.0;
  }
  float visibility(vec3 p, float ndl) {
    vec3 clip=(uSunVP*vec4(p,1.0)).xyz*.5+.5;
    if (clip.x<.007||clip.x>.993||clip.y<.007||clip.y>.993||clip.z<0.0||clip.z>1.0) return 1.0;
    float sampleDepth=clip.z-(.00018+.00135*(1.0-ndl));
    float result=0.0;
    for (int y=-1;y<=1;y++) for (int x=-1;x<=1;x++) {
      vec2 offset=vec2(float(x),float(y))*uShadowTexel*1.13;
      vec3 color=texture2D(uShadow,clip.xy+offset).rgb;
      float shadowDepth=dot(color,vec3(255.0,65280.0,16711680.0))/16777214.0;
      result+=step(sampleDepth,shadowDepth);
    }
    float edge=min(min(clip.x,1.0-clip.x),min(clip.y,1.0-clip.y));
    return mix(1.0,result/9.0,smoothstep(.007,.11,edge));
  }
  vec2 atlasCoord(float id,vec2 uv) {
    vec2 cell=vec2(mod(id,4.0),floor(id/4.0));
    return (cell+(8.0+496.0*fract(uv))/512.0)/vec2(4.0,2.0);
  }
  vec4 surfaceTexture(sampler2D atlas,vec2 at,vec2 uv) {
    ${hasGradient
      ? 'vec2 factor=vec2(496.0/2048.0,496.0/1024.0); return texture2DGradEXT(atlas,at,dFdx(uv)*factor,dFdy(uv)*factor);'
      : 'return texture2D(atlas,at);'}
  }
  vec3 displayMap(vec3 linearColor) {
    vec3 mapped=1.0-exp(-max(vec3(0.0),linearColor)*1.35);
    return pow(mapped,vec3(.4545));
  }
  vec3 nightLight(vec3 normal,vec3 position,vec3 view,float rough) {
    vec3 illumination=vec3(.023,.038,.067);
    for (int i=0;i<${streetLamps.length};i++) {
      vec3 delta=uLanterns[i]-position;
      float sqDistance=dot(delta,delta);
      if (sqDistance>215.0) continue;
      vec3 direction=normalize(delta);
      float shaped=smoothstep(.34,.92,direction.y)*(1.0-smoothstep(105.0,215.0,sqDistance));
      vec3 lightColor=mix(vec3(1.0,.61,.27),vec3(.63,.79,1.0),step(.8,mod(float(i),3.0))*.68);
      float diffuse=max(dot(normal,direction),0.0)*shaped*14.4/(sqDistance+1.6);
      float highlight=pow(max(dot(normal,normalize(view+direction)),0.0),mix(84.0,12.0,rough));
      illumination+=lightColor*(diffuse+highlight*shaped*3.1/(sqDistance+1.6));
    }
    vec3 beam=position-uHeadlamp;
    float sqDistance=dot(beam,beam);
    vec3 direction=normalize(beam);
    float cone=smoothstep(.64,.94,dot(direction,uAhead));
    float facing=max(dot(normal,-direction),0.0);
    illumination+=vec3(.82,.93,1.0)*cone*(.18+.82*facing)*11.0/(sqDistance+1.4);
    return illumination;
  }

  void main() {
    float packedId=floor(vMaterial+.5);
    float materialId=mod(packedId,${materialStride}.0);
    bool paint=materialId==16.0;
    bool vehicleSurface=materialId>16.5;
    float mat=paint ? 9.0 : materialId-(vehicleSurface ? 17.0 : 0.0);
    if (uPass==3&&vWorld.y<.17) discard;
    vec4 leaf=vec4(1.0);
    if (mat==11.0) {
      leaf=texture2D(uLeaves,vUV);
      if (leaf.a<.40) discard;
    }
    if (uPass==2) {
      gl_FragColor=vec4(encode(floor(min(gl_FragCoord.z,1.0)*16777214.0)),1.0);
      return;
    }
    if (uPass==1) {
      gl_FragColor=vec4(encode(clamp(floor(vDepth*1000.0+.5),1.0,16777215.0)),1.0);
      return;
    }
    if (uPass==4) {
      float category=uSemantic>=0.0 ? uSemantic : floor(packedId/${materialStride}.0);
      if (uSemantic<0.0&&category==0.0) {
        category=${label.building}.0;
        if (mat==1.0||mat==7.0) category=${label.road}.0;
        if (mat==2.0) category=${label.sidewalk}.0;
        if (mat==3.0||mat==12.0) category=${label.terrain}.0;
        if (mat==5.0||mat==11.0) category=${label.vegetation}.0;
        if (mat==15.0) category=${label.pole}.0;
        if (mat==13.0) category=${label.sign}.0;
      }
      gl_FragColor=vec4(vec3(category/255.0),1.0);
      return;
    }

    vec3 base=vehicleSurface ? vColor : vColor*uTint;
    float rough=.77, metal=0.0;
    vec3 geometric=normalize(vNormal);
    vec3 view=normalize(uEye-vWorld);
    if (dot(geometric,view)<0.0) geometric=-geometric;
    vec3 normal=geometric;
    float wet=uWeather.z;
    if (mat>=1.0&&mat<=6.0) {
      vec3 tangent=abs(geometric.x)>.72 ? vec3(0.0,0.0,1.0) : vec3(1.0,0.0,0.0);
      tangent=normalize(tangent-geometric*dot(tangent,geometric));
      vec3 bitangent=cross(geometric,tangent);
      float tile=mat==1.0 ? 1.8 : mat==4.0 ? 2.65 : mat==5.0 ? 1.0 : 2.25;
      vec2 uv=vec2(dot(vWorld,tangent),-dot(vWorld,bitangent))/tile;
      vec2 atlas=atlasCoord(mat,uv);
      vec3 photo=surfaceTexture(uAlbedo,atlas,uv).rgb;
      float macro=noise(vWorld.xz*.23+vWorld.y*.083);
      if (mat==1.0) {
        float asphalt=dot(photo,vec3(.333))*1.78;
        float bikeColor=smoothstep(.018,.09,base.g-base.r);
        vec3 pavement=mix(vec3(.63,.65,.68),base*1.48,bikeColor);
        base=pavement*(.34+asphalt)*(.91+.14*macro);
      } else if (mat==3.0) {
        base=mix(photo*vec3(.85,1.03,.60),base,.36)*(.80+.31*macro);
      } else if (mat==6.0) {
        base=mix(base,photo*1.8,.27)*(.88+.14*macro);
      } else {
        base=mix(photo,base,mat==5.0 ? .23 : .36)*(.87+.19*macro);
      }
      vec4 detail=surfaceTexture(uRelief,atlas,uv);
      float strength=(mat==5.0 ? .68 : .36)*(1.0-smoothstep(9.0,36.0,vDepth));
      vec2 bump=detail.rg*2.0-1.0;
      normal=normalize(geometric+strength*(bump.x*tangent+bump.y*bitangent));
      rough=clamp(detail.a,.34,.95);
      if (mat==1.0||mat==2.0) {
        float wetness=wet*(.4+.6*smoothstep(.35,.72,macro));
        rough=mix(rough,.22,wetness);
        base*=1.0-wetness*.32;
      }
    }
    if (mat==7.0) {
      float wear=smoothstep(.31,.74,noise(vWorld.xz*21.0));
      base*=.63+.37*wear;
      rough=.9;
    }
    if (mat==8.0) { rough=.19;metal=.12; }
    if (mat==9.0) { rough=.24;metal=.18; }
    if (mat==10.0) { rough=.37;metal=.48; }
    if (mat==11.0) {
      base=mix(leaf.rgb*1.37,leaf.rgb*vColor*1.45,.38);
      rough=.73;
    }
    if (mat==12.0) {
      float wave1=sin(vWorld.x*5.9+vWorld.z*2.7+uTime*1.85);
      float wave2=sin(vWorld.x*1.1-vWorld.z*8.2+uTime*2.4);
      normal=normalize(normal+vec3(wave1*.079,0.0,wave2*.032));
      rough=.12;
    }
    if (mat==13.0) { base=texture2D(uSign,vUV).rgb; rough=.46; }
    if (uSnow>.5 && mat>=1.0&&mat<=3.0) {
      float snow=smoothstep(.19,.74,noise(vWorld.xz*.34))*.55+(mat==1.0?.19:.42);
      base=mix(base,vec3(.88,.91,.94),snow*max(.0,geometric.y));
      rough=mix(rough,.81,snow);
    }
    vec3 albedo=pow(clamp(base,0.0,1.0),vec3(2.1));
    float sunFacing=max(dot(normal,uSun),0.0);
    float direct=visibility(vWorld,max(dot(geometric,uSun),0.0));
    vec3 horizon=uHaze;
    float ambientUp=normal.y*.5+.5;
    vec3 ambient=mix(vec3(.27,.24,.22),vec3(.33,.42,.55),ambientUp);
    vec3 sunlightTint=vec3(1.53+uWeather.w*.30,1.25,.88-uWeather.w*.21);
    vec3 sunColor=mix(sunlightTint,vec3(.78,.88,1.02),wet);
    float strength=mix(1.02,.18,wet);
    float scatter=mat==11.0 ? abs(dot(normal,uSun))*.3+.14 : 0.0;
    vec3 lit=albedo*(ambient+sunColor*strength*(sunFacing+scatter)*direct);
    if (uNight) lit=albedo*nightLight(normal,vWorld,view,rough);
    float ndv=max(dot(normal,view),.02);
    vec3 halfVector=normalize(view+uSun);
    float ndh=max(dot(normal,halfVector),.02);
    float alpha=rough*rough;
    float term=ndh*ndh*(alpha*alpha-1.0)+1.0;
    float highlight=alpha*alpha/(PI*term*term+.001);
    vec3 f0=mix(vec3(mat==8.0 ? .095 : .045),albedo,metal);
    vec3 fresnel=f0+(1.0-f0)*pow(1.0-ndv,5.0);
    if (!uNight) lit+=fresnel*highlight*sunFacing*strength*direct*sunColor*.43;

    if (mat==8.0||mat==9.0||mat==10.0||mat==12.0||((mat==1.0||mat==2.0)&&wet>.03)) {
      vec3 bounced=reflect(-view,normal);
      vec3 reflection=pow(max(skyColor(bounced),0.0),vec3(2.0));
      float reflectivity=mat==8.0 ? .47 : mat==12.0 ? .76 : mat==9.0 ? .34 : mat==10.0 ? .2 : wet*.19;
      float grazing=smoothstep(.0,.65,1.0-ndv);
      lit+=reflection*reflectivity*(.21+.79*grazing);
      if (uReflect&&mat==1.0&&normal.y>.66&&vWorld.y<.10) {
        vec4 clip=uReflectionVP*vec4(vWorld.x,0.0,vWorld.z,1.0);
        vec2 uv=clip.xy/clip.w*.5+.5;
        vec2 ripple=vec2(noise(vWorld.xz*9.1),noise(vWorld.zx*8.3))-.5;
        uv+=ripple*.003;
        float edge=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
        float moisture=smoothstep(.23,.74,noise(vWorld.xz*.36));
        float sheen=wet*moisture*pow(grazing,1.55)*smoothstep(.001,.045,edge)*.43;
        vec3 mirror=pow(texture2D(uReflection,uv).rgb,vec3(2.1));
        lit=mix(lit,mirror,sheen);
      }
    }
    if (mat==14.0) lit+=albedo*.66;
    if (mat==15.0&&uNight) lit+=vec3(1.38,.93,.44);
    float fog=1.0-exp(-pow(vDepth/max(3.0,uWeather.y),1.33));
    vec3 viewSky=mix(horizon,vec3(.49,.64,.77),max(-view.y,0.0));
    vec3 rgb=displayMap(lit*uWeather.x);
    rgb=mix(rgb,mix(horizon,viewSky,uNight?.02:.35),fog*.93);
    ${hasProjection?`if (uPhoto && (mat<=7.0||mat==11.0)) {
      vec4 photoClip=uPhotoVP*vec4(vWorld,1.0);
      // Fine near-field surfaces need the asset texture when a distant photo
      // texel would cover many pixels in the current camera.
      float footprint=smoothstep(.54,.94,vDepth/max(.05,photoClip.w));
      rgb=projectedColor(rgb,photoClip,false,.83*footprint)*mix(.83,1.0,direct);
    }`:''}
    gl_FragColor=vec4(rgb,1.0);
  }
`;

export const rainFragment = `
  precision highp float;
  varying vec2 vScreen;
  uniform float uTime, uAspect, uIntensity, uSnow;
  float hash(vec2 p) {
    return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);
  }
  float drops(vec2 p,float time,float scale,float lengthFactor) {
    p=vec2((p.x+p.y*.20)*uAspect,p.y);
    p*=vec2(89.0,13.0)*scale;
    float column=floor(p.x);
    p.y+=time*(13.0+7.0*hash(vec2(column,2.0)))+hash(vec2(column,5.0))*29.0;
    vec2 cell=floor(p),within=fract(p);
    float width=mix(.021,.10,hash(cell));
    float length=mix(.07,.55,hash(cell+11.0))*lengthFactor;
    float farEdge=length+.09;
    float body=(1.0-smoothstep(width,width+.047,abs(within.x-.5)));
    body*=smoothstep(.0,.07,within.y)*(1.0-smoothstep(length,farEdge,within.y));
    return body*step(.76-max(0.0,uIntensity-1.0)*.18,hash(cell+22.0));
  }
  float flakes(vec2 uv,float scale,float time) {
    vec2 p=uv*vec2(38.0*uAspect,24.0)*scale+vec2(time*3.6,time*7.2);
    vec2 cell=floor(p),f=fract(p);
    vec2 seed=vec2(hash(cell+2.0),hash(cell+21.0));
    vec2 dotAt=.26+.48*seed+vec2(sin(time*1.4+seed.x*18.0)*.13,0.0);
    return (1.0-smoothstep(.04,.10+seed.x*.05,length(f-dotAt)))*step(.57,seed.y);
  }
  void main() {
    vec2 p=vScreen*.5+.5;
    if (uSnow>.5) {
      float amount=flakes(p,1.0,uTime)+flakes(p+.17,1.46,uTime*.54)*.52;
      gl_FragColor=vec4(vec3(.88,.94,1.0),amount*.46);
      return;
    }
    float near=drops(p,uTime,1.0,1.0);
    float far=drops(p+vec2(.142,.213),uTime*.77,1.72,.72);
    float center=exp(-pow((p.x-.51)*2.1,2.0))*smoothstep(.38,.82,p.y);
    gl_FragColor=vec4(vec3(.68,.78,.91),(.12+center*.18)*(near+far*.40)*min(1.52,uIntensity));
  }
`;
