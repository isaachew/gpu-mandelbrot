var rcanv=document.getElementById("render-canvas")
var rcontext=rcanv.getContext("2d")
var glcanv=document.getElementById("webgl-canvas")
var glcont=glcanv.getContext("webgl2",{preserveDrawingBuffer: true})
function createShader(context,type,program){
    var shader=context.createShader(type)
    context.shaderSource(shader,program)
    context.compileShader(shader)
    if(!context.getShaderParameter(shader,context.COMPILE_STATUS)){
        console.log((type==context.FRAGMENT_SHADER?"fragment":"vertex")+" shader error:\n"+context.getShaderInfoLog(shader))
    }
    return shader
}
function createProgram(context,vertSource,fragSource){
    var vertShader=createShader(context,context.VERTEX_SHADER,vertSource)
    var fragShader=createShader(context,context.FRAGMENT_SHADER,fragSource)
    var shaderProgram=context.createProgram()
    context.attachShader(shaderProgram,vertShader)
    context.attachShader(shaderProgram,fragShader)
    context.linkProgram(shaderProgram)//finalise program
    if(!context.getProgramParameter(shaderProgram,context.LINK_STATUS)){
        console.log("program linking error:\n"+context.getProgramInfoLog(shaderProgram))
    }
    return shaderProgram
}
var mandelProgram=createProgram(glcont,`#version 300 es
precision highp float;
in vec2 position;//-1 to 1
uniform vec2 posOffset;
uniform float scale;
out vec2 fractalPos;
void main(){
    gl_Position=vec4(position,0.0,1.0);
    fractalPos=position*scale+posOffset;
}
`,`#version 300 es
precision highp float;
precision highp int;
in vec2 fractalPos;
uniform int numzooms;//additional number of zooms to do after float

uniform int maxiters;//make sure small otherwise GPU will crash
uniform highp sampler2D lastorbit;//information about previous iterations: x, y, exp, number of iterations
uniform highp sampler2D lastorbit2;//glitch detection
uniform highp sampler2D reference;//reference orbit
uniform float glitchSensitivity;
uniform int paletteparam;
layout(location=0) out vec4 outputColour;//colour
layout(location=1) out vec4 orbitInfo;//output x, y, exp, number of iterations
layout(location=2) out vec4 orbitInfo2;//output x, y, exp, number of iterations

vec2 complexmul(vec2 a,vec2 b){
    return vec2(a.x*b.x-a.y*b.y,a.x*b.y+a.y*b.x);
}

//Functions for managing floats
int ilog2(float x){//floor(log(|x|)), clamped to [-127,128]
    int intRep=floatBitsToInt(x);
    return ((intRep>>23)&255)-127;
}
float iexp2(int x){
    int floatRep=clamp(x+127,0,255)<<23;
    return intBitsToFloat(floatRep);
}
//Floatexp
struct floatexp{
    float mantissa;//magnitude is always between 1 and 2
    int exponent;
};

floatexp add(floatexp a,floatexp b){
    int maxexp=max(a.exponent,b.exponent);
    floatexp result=floatexp(iexp2(a.exponent-maxexp)*a.mantissa+iexp2(b.exponent-maxexp)*b.mantissa,maxexp);
    int expneeded=ilog2(result.mantissa);
    result.mantissa*=iexp2(-expneeded);
    result.exponent=maxexp+expneeded;
    if(result.mantissa==0.0){//zero
        result.exponent=-21474836;
    }
    return result;
}
floatexp neg(floatexp x){
    return floatexp(-x.mantissa,x.exponent);
}
floatexp sub(floatexp a,floatexp b){
    return add(a,neg(b));
}
floatexp mul(floatexp a,floatexp b){
    floatexp result=floatexp(a.mantissa*b.mantissa,a.exponent+b.exponent);
    if(abs(result.mantissa)>=2.0){
        result.mantissa*=0.5;
        result.exponent++;
    }
    if(result.mantissa==0.0){//zero
        result.exponent=-21474836;
    }
    return result;
}
floatexp mulpow2(int a,floatexp b){//a is powers of 2
    b.exponent+=a;
    return b;
}


float fromfloatexp(floatexp x){
    return x.mantissa*iexp2(x.exponent);
}
floatexp tofloatexp(float x){
    if(x==0.0)return floatexp(0.0,-21474836);
    int expneeded=ilog2(x);
    return floatexp(x*iexp2(-expneeded),expneeded);
}

//Complex floatexp
struct exp_complex{
    vec2 mantissa;//magnitude is always between 1 and 2
    int exponent;
};

exp_complex add(exp_complex a,exp_complex b){
    int maxexp=max(a.exponent,b.exponent);
    exp_complex result=exp_complex(iexp2(a.exponent-maxexp)*a.mantissa+iexp2(b.exponent-maxexp)*b.mantissa,maxexp);
    int expneeded=ilog2(dot(result.mantissa,result.mantissa))>>1;
    result.mantissa*=iexp2(-expneeded);
    result.exponent=maxexp+expneeded;
    if(result.mantissa==vec2(0.0,0.0)){//zero
        result.exponent=-21474836;
    }
    return result;
}
exp_complex neg(exp_complex x){
    return exp_complex(-x.mantissa,x.exponent);
}
exp_complex sub(exp_complex a,exp_complex b){
    return add(a,neg(b));
}
exp_complex mul(exp_complex a,exp_complex b){
    exp_complex result=exp_complex(complexmul(a.mantissa,b.mantissa),a.exponent+b.exponent);
    if(dot(result.mantissa,result.mantissa)>=4.0){
        result.mantissa*=0.5;
        result.exponent++;
    }
    if(result.mantissa==vec2(0.0,0.0)){//zero
        result.exponent=-21474836;
    }
    return result;
}
exp_complex mulpow2(int a,exp_complex b){//a is powers of 2
    b.exponent+=a;
    return b;
}

vec2 fromfloatexp(exp_complex x){
    return x.mantissa*iexp2(x.exponent);
}
exp_complex tofloatexp(vec2 x){
    if(x==vec2(0.0,0.0))return exp_complex(vec2(0.0,0.0),-21474836);
    int expneeded=ilog2(dot(x,x))>>1;
    return exp_complex(x*iexp2(-expneeded),expneeded);
}

exp_complex getRef(int iters){
    vec4 curValue=texelFetch(reference,ivec2(iters&16383,iters>>14),0);
    return exp_complex(curValue.xy,int(curValue.z));
}

void main(){
    vec4 posData=texelFetch(lastorbit,ivec2(gl_FragCoord.xy),0);
    vec4 posData2=texelFetch(lastorbit2,ivec2(gl_FragCoord.xy),0);
    if(posData.xy==vec2(0.0,0.0))posData.z=-21474836.0;
    exp_complex curpos=exp_complex(posData.xy,int(posData.z));
    int olditers=floatBitsToInt(posData.w);
    if(olditers<0){//stopped already
        outputColour=vec4(intBitsToFloat(olditers),0.0,0.0,0.0);
        orbitInfo=posData;//don't do anything
        orbitInfo2=posData2;
        return;
    }
    floatexp relerr=floatexp(posData2.y,floatBitsToInt(posData2.z));

    int numiters=-1;
    bool isglitch=false;
    float curlderiv=posData2.x;
    exp_complex floatexpPosition=tofloatexp(fractalPos);
    floatexpPosition.exponent+=numzooms;
    float lcrad=log2(length(floatexpPosition.mantissa))+float(floatexpPosition.exponent);
    for(int i=0;i<maxiters;i++){
        exp_complex curref=getRef(i+olditers);
        exp_complex unperturbed=add(curpos,curref);
        if(unperturbed.exponent>=1){
            numiters=i;
            break;
        }
        if(curref.exponent>=1){
            isglitch=true;
            numiters=-2;//glitch with least priority
            break;
        }

        float lrad_oldpos=log2(length(curpos.mantissa))+float(curpos.exponent);
        float lrad_unpert=log2(length(unperturbed.mantissa))+float(unperturbed.exponent);
        float lrad_ref=log2(length(curref.mantissa))+float(curref.exponent);

        if(lrad_unpert<lrad_ref-7.0){
                //numiters+=23424;
                //break;
                isglitch=true;
                numiters=-2+min(0,unperturbed.exponent);
                break;
        }


        if(i>0||olditers>0){
            curlderiv+=1.0+lrad_unpert;
        }

        //exp_complex refoffset=mulpow2(1,mul(curref,curpos));
        curpos=add(mul(add(mulpow2(1,curref),curpos),curpos),floatexpPosition);

        if(paletteparam==1){
            float lrad_cur=log2(length(curpos.mantissa))+float(curpos.exponent);
            float maxld=lrad_cur;
            float curlerr=maxld-curlderiv;
            relerr=add(relerr,floatexp(1.0,int(curlerr)));
            float lrelerr=log2(relerr.mantissa)+float(relerr.exponent);
            //abs(precision*z) = error; sum the error up over iterations?
            //total error>abs(pixelSize*z') then bailout
            //precision is 2^-24
            if(lrelerr>-glitchSensitivity){
                isglitch=true;
                numiters=-(i+olditers)-2;
                break;
            }
        }
    }
    if(numiters>=0)numiters+=olditers;
    outputColour=vec4(intBitsToFloat(numiters),0.0,0.0,0.0);
    if(numiters==-1)numiters=maxiters+olditers;
    orbitInfo=vec4(curpos.mantissa.xy,float(curpos.exponent),intBitsToFloat(numiters));
    orbitInfo2=vec4(curlderiv,relerr.mantissa,intBitsToFloat(relerr.exponent),0.0);
    /*
    if(numiters==-1){
        outputColour=vec4(curpos.mantissa.x,curpos.mantissa.y,0.5,1.0);
    }
    */
}

`)
var texRenderProgram=createProgram(glcont,`#version 300 es
precision highp float;
in vec2 position;//-1 to 1
uniform float scale;
void main(){
    gl_Position=vec4(position,0.0,1.0);
}`,`#version 300 es
precision highp float;
uniform highp sampler2D render;
layout (location=0) out vec4 outputColour;
void main(){
    vec4 ctex=texelFetch(render,ivec2(gl_FragCoord.xy),0);
    int iters=floatBitsToInt(ctex.x);
    outputColour=vec4(float(iters&255)/255.0,float((iters>>8)&255)/255.0,float((iters>>16)&255)/255.0,float((iters>>24)&255)/255.0);
}`)

console.time("hi")
console.log(performance.now())

var tileWidth=256,tileHeight=256
var curWidth=1024,curHeight=1024
//glcanv.width=tileWidth,glcanv.height=tileHeight
//glcont.viewport(0,0,tileWidth,tileHeight)

//Draw a square covering the whole screen
var positionIndex=glcont.getAttribLocation(mandelProgram,"position")
var positionBuffer=glcont.createBuffer()
glcont.bindBuffer(glcont.ARRAY_BUFFER,positionBuffer)
glcont.bufferData(glcont.ARRAY_BUFFER,new Float32Array([-1,-1,-1,1,1,1,1,-1]),glcont.STATIC_DRAW)
glcont.enableVertexAttribArray(positionIndex)//enable "position" attribute to be bound to a buffer
glcont.vertexAttribPointer(positionIndex,2,glcont.FLOAT,false,0,0)//how the data is read from buffer
var offsetIndex=glcont.getUniformLocation(mandelProgram,"posOffset")
var scaleIndex=glcont.getUniformLocation(mandelProgram,"scale")
var sensitivityIndex=glcont.getUniformLocation(mandelProgram,"glitchSensitivity")
var refIndex=glcont.getUniformLocation(mandelProgram,"reference")


glcont.useProgram(mandelProgram)

//enable texture
function enableTexture(){//enables NPOT textures to work
    glcont.texParameteri(glcont.TEXTURE_2D,glcont.TEXTURE_MIN_FILTER,glcont.NEAREST)
    glcont.texParameteri(glcont.TEXTURE_2D,glcont.TEXTURE_MAG_FILTER,glcont.NEAREST)
    glcont.texParameteri(glcont.TEXTURE_2D,glcont.TEXTURE_WRAP_S,glcont.CLAMP_TO_EDGE)
    glcont.texParameteri(glcont.TEXTURE_2D,glcont.TEXTURE_WRAP_T,glcont.CLAMP_TO_EDGE)
}


//texture for reference information
var ptex=glcont.createTexture()
glcont.activeTexture(glcont.TEXTURE0)
glcont.bindTexture(glcont.TEXTURE_2D,ptex)
enableTexture()
//reference is in texture unit 0
glcont.uniform1i(refIndex,0)

var curtex;
function genReference(cval){
    var farr=new Float32Array(32768)
    var zval=new BigComplex(0,0);
    //var occurred=new Map()
    //var period=null
    var escaped=false
    for(var i=0;i<16384;i++){
        var [zx,zy]=zval.toFloats()
        farr[i*2]=zx;
        farr[i*2+1]=zy;
        if(!escaped){
            try{
                zval=zval.mul(zval).add(cval)
            }catch{
                escaped=true
            }
        }
        /*
        if(occurred.has(""+[zx,zy])&&period==null){
            console.log("found",occurred.get(""+[zx,zy]),i)
            period=occurred.get(""+[zx,zy])-i
        }
        occurred.set(""+[zx,zy],i)
        */
    }
    glcont.texImage2D(glcont.TEXTURE_2D,0,glcont.RG32F,16384,1,0,glcont.RG,glcont.FLOAT,farr)

}
var maxiters=16384
function genReference(cval){//write floatexp
    var farr=new Float32Array(Math.ceil(maxiters/16384)*16384*3)
    var zval=new BigComplex(0,0);

    curtex=farr
    //var occurred=new Map()
    //var period=null
    var escaped=false
    for(var i=0;i<maxiters;i++){
        var [zx,zy,zexp]=zval.toFloatexp()
        farr[i*3]=zx;
        farr[i*3+1]=zy;
        farr[i*3+2]=zexp;
        if(!escaped){
            try{
                zval=zval.mul(zval).add(cval)
            }catch{
                escaped=true
            }
        }
        /*
        if(occurred.has(""+[zx,zy])&&period==null){
            console.log("found",occurred.get(""+[zx,zy]),i)
            period=occurred.get(""+[zx,zy])-i
        }
        occurred.set(""+[zx,zy],i)
        */
    }

    glcont.activeTexture(glcont.TEXTURE0)
    glcont.texImage2D(glcont.TEXTURE_2D,0,glcont.RGB32F,Math.min(maxiters,16384),Math.ceil(maxiters/16384),0,glcont.RGB,glcont.FLOAT,farr)

}


//From last orbit
/*
Texture unit 0: reference
Texture unit 1: to render into
Texture unit 2: orbit1 read
Texture unit 3: orbit2 read
Texture unit 4: orbit1 write
Texture unit 5: orbit write

*/
var floatExt=glcont.getExtension("EXT_color_buffer_float")
var curFramebuffer=glcont.createFramebuffer()
var renderTex=glcont.createTexture()
glcont.activeTexture(glcont.TEXTURE1)
glcont.bindTexture(glcont.TEXTURE_2D,renderTex)
glcont.texImage2D(glcont.TEXTURE_2D,0,glcont.RGBA32F,tileWidth,tileHeight,0,glcont.RGBA,glcont.FLOAT,null)
enableTexture()

glcont.bindFramebuffer(glcont.DRAW_FRAMEBUFFER,curFramebuffer)
var orbitTextures=[glcont.createTexture(),glcont.createTexture()]
var newOrbitTextures=[glcont.createTexture(),glcont.createTexture()]
glcont.activeTexture(glcont.TEXTURE2)
glcont.bindTexture(glcont.TEXTURE_2D,orbitTextures[0])
glcont.texImage2D(glcont.TEXTURE_2D,0,glcont.RGBA32F,tileWidth,tileHeight,0,glcont.RGBA,glcont.FLOAT,null)
enableTexture()

glcont.activeTexture(glcont.TEXTURE3)
glcont.bindTexture(glcont.TEXTURE_2D,orbitTextures[1])
glcont.texImage2D(glcont.TEXTURE_2D,0,glcont.RGBA32F,tileWidth,tileHeight,0,glcont.RGBA,glcont.FLOAT,null)
enableTexture()

glcont.activeTexture(glcont.TEXTURE4)
glcont.bindTexture(glcont.TEXTURE_2D,newOrbitTextures[0])
glcont.texImage2D(glcont.TEXTURE_2D,0,glcont.RGBA32F,tileWidth,tileHeight,0,glcont.RGBA,glcont.FLOAT,null)
enableTexture()

glcont.activeTexture(glcont.TEXTURE5)
glcont.bindTexture(glcont.TEXTURE_2D,newOrbitTextures[1])
glcont.texImage2D(glcont.TEXTURE_2D,0,glcont.RGBA32F,tileWidth,tileHeight,0,glcont.RGBA,glcont.FLOAT,null)
enableTexture()

glcont.framebufferTexture2D(glcont.FRAMEBUFFER,glcont.COLOR_ATTACHMENT0,glcont.TEXTURE_2D,renderTex,0)
glcont.framebufferTexture2D(glcont.FRAMEBUFFER,glcont.COLOR_ATTACHMENT1,glcont.TEXTURE_2D,newOrbitTextures[0],0)
glcont.framebufferTexture2D(glcont.FRAMEBUFFER,glcont.COLOR_ATTACHMENT2,glcont.TEXTURE_2D,newOrbitTextures[1],0)




console.timeEnd("hi")
var fixedFactor=896n
function getDecimalValue(num,digits=Number(fixedFactor)+1){
    var st=""
    if(num<0){
        num=-num
        st+="-"
    }
    for(var i=0;i<digits;i++){
        if(i==digits-1)num+=1n<<(fixedFactor-1n)//round
        var nump=num>>fixedFactor
        st+=nump
        if(i==0)st+="."
        num-=nump<<fixedFactor
        num*=10n
    }
    return st
}
function fromDecimalValue(val){
    var num=0n
    var isNegative=false
    if(val[0]=="-"){
        isNegative=true
        val=val.slice(1)
    }
    var pointIndex=val.indexOf(".")
    for(var i=val.length-1;i>pointIndex;i--){
        var curdigit=+(val[i])
        num+=(1n<<fixedFactor)*BigInt(curdigit)
        num/=10n
    }
    num+=(1n<<fixedFactor)*BigInt(val.slice(0,pointIndex))
    if(isNegative)num=-num
    return num
}
class BigComplex{
    real;imag
    constructor(re,im){
        if(typeof re=="bigint"){
            var unit=1n<<fixedFactor
            if(re>unit*1000n||re<-unit*1000n){
                throw "too big"
            }
            if(im>unit*1000n||im<-unit*1000n){
                throw "too big"
            }
            this.real=re,this.imag=im
        }else if(typeof re=="string"){
            this.real=fromDecimalValue(re)
            this.imag=fromDecimalValue(im)
        }else{
            this.real=BigInt(Math.round(re*2**Number(fixedFactor)))
            this.imag=BigInt(Math.round(im*2**Number(fixedFactor)))
        }
    }
    add(oth){
        return new BigComplex(this.real+oth.real,this.imag+oth.imag)
    }
    sub(oth){
        return new BigComplex(this.real-oth.real,this.imag-oth.imag)
    }
    mul(oth){
        var realPart=(this.real*oth.real-this.imag*oth.imag)>>fixedFactor
        var imagPart=(this.real*oth.imag+this.imag*oth.real)>>fixedFactor
        return new BigComplex(realPart,imagPart)
    }
    toFloats(){
        var factor=2**Number(fixedFactor)
        return [Number(this.real)/factor,Number(this.imag)/factor]
    }
    toFloatexp(){
        var floats=this.toFloats()
        var expFactor=Math.floor(Math.log2(Math.hypot(...floats)))
        if(!Number.isFinite(expFactor))return [0,0,-21474836]//yes
        return [floats[0]*2**-expFactor,floats[1]*2**-expFactor,expFactor]
    }
    rad(){
        return Math.hypot(...this.toFloats())
    }
}

var curpos=new BigComplex(0n,0n),curzoom=2,curval=0,glitchSensitivity=1/(2**24)*512/3,maxiters=16384
var curref=new BigComplex(0n,0n)//e-6
var maxstepiters=10000,curstepiters=100,curiters=0
genReference(new BigComplex(0,0))
var swapTextures=false

var readBuffer=new Uint8Array(4096)//where readpixels
var glitchDetection=false
var lastCanvasWrite=0
function renderStep(){
    var renderediters=Math.min(curstepiters,maxiters-curiters)
    if(renderediters==0){
        writeTile()
        return
    }
    var drawStart=performance.now()
    glcont.useProgram(mandelProgram)
    glcont.uniform1i(glcont.getUniformLocation(mandelProgram,"maxiters"),renderediters)
    glcont.uniform1i(glcont.getUniformLocation(mandelProgram,"lastorbit"),swapTextures?4:2)//last orbit in texture unit 2 or 4
    glcont.uniform1i(glcont.getUniformLocation(mandelProgram,"lastorbit2"),swapTextures?5:3)//last orbit in texture unit 3 or 5
    glcont.bindFramebuffer(glcont.FRAMEBUFFER,curFramebuffer)
    glcont.framebufferTexture2D(glcont.FRAMEBUFFER,glcont.COLOR_ATTACHMENT1,glcont.TEXTURE_2D,swapTextures?orbitTextures[0]:newOrbitTextures[0],0)//render to newOrbitTexture
    glcont.framebufferTexture2D(glcont.FRAMEBUFFER,glcont.COLOR_ATTACHMENT2,glcont.TEXTURE_2D,swapTextures?orbitTextures[1]:newOrbitTextures[1],0)//render to newOrbitTexture
    glcont.drawBuffers([glcont.COLOR_ATTACHMENT0,glcont.COLOR_ATTACHMENT1,glcont.COLOR_ATTACHMENT2])
    glcont.drawArrays(glcont.TRIANGLE_FAN,0,4)


    glcont.bindFramebuffer(glcont.FRAMEBUFFER,null)
    glcont.drawBuffers([glcont.BACK])
    glcont.useProgram(texRenderProgram)//renders from an existing texture
    glcont.uniform1i(glcont.getUniformLocation(texRenderProgram,"render"),1)
    glcont.drawArrays(glcont.TRIANGLE_FAN,0,4)
    glcont.useProgram(mandelProgram)

    //force gl.finish
    glcont.readPixels(0,0,32,32,glcont.RGBA,glcont.UNSIGNED_BYTE,readBuffer)
    var drawEnd=performance.now()
    var drawTime=drawEnd-drawStart
    if(drawTime<50){
        curstepiters*=2
        curstepiters=Math.min(curstepiters,maxstepiters)
    }
    if(drawTime>100){
        curstepiters/=2
        curstepiters=Math.max(curstepiters,100)
    }
    console.log(drawEnd-drawStart+"ms for "+renderediters+" iterations")
    var curTime=+new Date
    if(curTime-lastCanvasWrite>2000){
        toCanvas()
        lastCanvasWrite=+new Date
    }
    swapTextures=!swapTextures
    curiters+=renderediters
    numRenderedIters.textContent=curiters
    setTimeout(renderStep)
}
var blackArray=new Float32Array(tileWidth*tileHeight*4)//to reset to black
var orbitArray=new Float32Array(tileWidth*tileHeight*4)//to set orbit
var orbitIntArray=new Int32Array(orbitArray.buffer)
var renderStart=0

var tileOffX=300
var tileOffY=300
function startRender(){
    curstepiters=100
    numReferences++
    if(curzoom<=1e-250){
        console.log("limit")
        curzoom=1e-250
    }
    curiters=0
    var pnow=performance.now()

    var fcoords=curpos.sub(curref).toFloats()
    var clscale=Math.floor(Math.log2(curzoom))
    console.log("offset ",[fcoords[0]*2**-clscale,fcoords[1]*2**-clscale])
    console.log("scale ",curzoom*2**-clscale)
    console.log("iters ",maxiters)
    console.log("zooms ",clscale)
    console.log("sensitivity ",Math.log2(glitchSensitivity/curzoom))
    glcont.useProgram(mandelProgram)
    glcont.uniform2fv(offsetIndex,[fcoords[0]*2**-clscale,fcoords[1]*2**-clscale])

    glcont.uniform1f(scaleIndex,curzoom*2**-clscale)
    glcont.uniform1i(glcont.getUniformLocation(mandelProgram,"maxiters"),Math.min(maxiters,maxstepiters))
    glcont.uniform1i(glcont.getUniformLocation(mandelProgram,"numzooms"),clscale)
    glcont.uniform1f(sensitivityIndex,Math.log2(glitchSensitivity/curzoom))
    lastCanvasWrite=0
    glcont.viewport(-tileOffX,-curHeight+(tileOffY+tileHeight),curWidth,curHeight)
    /*
    glcont.uniform2fv(offsetIndex,curpos.sub(curref).toFloats())
    glcont.uniform1f(scaleIndex,curzoom)
    */
    //reset textures
    glcont.activeTexture(glcont.TEXTURE2)
    glcont.texImage2D(glcont.TEXTURE_2D,0,glcont.RGBA32F,tileWidth,tileHeight,0,glcont.RGBA,glcont.FLOAT,orbitArray)
    glcont.activeTexture(glcont.TEXTURE3)
    glcont.texImage2D(glcont.TEXTURE_2D,0,glcont.RGBA32F,tileWidth,tileHeight,0,glcont.RGBA,glcont.FLOAT,blackArray)
    swapTextures=false
    renderStart=performance.now()
    renderStep()
}

function render(){
    resetRender()
    startRender()
}
document.getElementById("render-canvas").addEventListener("mousedown",e=>{
    var crect=e.target.getBoundingClientRect()
    var xoffset=(e.offsetX/(crect.right-crect.left)-0.5)*2*curzoom
    var yoffset=-(e.offsetY/(crect.bottom-crect.top)-0.5)*2*curzoom
    curpos=curpos.add(new BigComplex(xoffset,yoffset))
    if(e.button==0)curzoom/=2
    if(e.button==2)curzoom*=2
    render()
    e.preventDefault()
})
document.getElementById("render-canvas").addEventListener("contextmenu",e=>{
    e.preventDefault()
})
var curox,curoy;
document.getElementById("render-canvas").addEventListener("mousemove",e=>{
    var crect=e.target.getBoundingClientRect()
    curox=(e.offsetX/(crect.right-crect.left)-0.5)*2*curzoom
    curoy=-(e.offsetY/(crect.bottom-crect.top)-0.5)*2*curzoom
})
document.addEventListener("keydown",e=>{
    if(e.key=="a"){
        curzoom/=2
        render()
    }
    if(e.key=="b"){
        curzoom*=2
        render()
    }
    if(e.key=="p"){
        curref=curpos;
        genReference(curpos)
        startRender()
    }
    if(e.key=="r"){
        curref=curpos.add(new BigComplex(curox,curoy));
        genReference(curref)
        startRender()
    }
    if(e.key=="e"){
        curval=(curval+1)%4
        glcont.uniform1i(glcont.getUniformLocation(mandelProgram,"paletteparam"),curval/**curzoom*/)
        render()
    }
    if(e.key=="x"){
        render()
    }
})
document.getElementById("gotoLocation").addEventListener("click",a=>{
    var nxpos=document.getElementById("xPosition").value
    var nypos=document.getElementById("yPosition").value
    curpos=new BigComplex(nxpos,nypos)
})


var curBitmap=rcontext.createImageData(rcanv.width,rcanv.height)
var curData=new Int32Array(curWidth*curHeight)
var curDataByte=new Uint8Array(curData.buffer)
var pixelsAffected=0
var numReferences=0
var tileNum=0//out of 16 for now
function resetRender(){
    for(var i=0;i<curData.length;i++){
        curData[i]=-1
    }
    for(var i=0;i<tileHeight;i++){
        for(var j=0;j<tileWidth;j++){
            orbitIntArray[(i*tileWidth+j)*4+3]=0
        }
    }
}
var palette={"stops":[{"position":0,"colour":[138,220,255]},{"position":0.12235491071428571,"colour":[47,93,167]},{"position":0.3587109375,"colour":[237,237,237]},{"position":0.6516127232142858,"colour":[16,174,213]},{"position":0.8173604910714286,"colour":[48,103,145]},{"position":1,"colour":[138,220,255]}],"length":600}
function paletteFunc(x){
    if(x<0)return x*10|0
    if(!isFinite(x))return -16777216
    x+=palette.time||0
    let progress=x%palette.length/palette.length
    let palind=palette.stops.findIndex(a=>a.position>progress)
    let colprog=(progress-palette.stops[palind-1].position)/(palette.stops[palind].position-palette.stops[palind-1].position)
    let cr=palette.stops[palind].colour[0]*colprog+palette.stops[palind-1].colour[0]*(1-colprog)
    let cg=palette.stops[palind].colour[1]*colprog+palette.stops[palind-1].colour[1]*(1-colprog)
    let cb=palette.stops[palind].colour[2]*colprog+palette.stops[palind-1].colour[2]*(1-colprog)
    return (cb<<16)|(cg<<8)|cr|-16777216
}
function writeTile(){

}
function toCanvas(){
    var pixels=new Uint8Array(tileWidth*tileHeight*4)
    glcont.readPixels(0,0,tileWidth,tileHeight,glcont.RGBA,glcont.UNSIGNED_BYTE,pixels)
    var intPixels=new Int32Array(pixels.buffer)
    for(var i=0;i<tileHeight;i++){
        for(var j=0;j<tileWidth;j++){
            var curPixValue=intPixels[(tileHeight-1-i)*tileWidth+j]
            var imageIndex=(i+tileOffY)*curWidth+(j+tileOffX)
            var existingValue=curData[imageIndex]
            if(existingValue==-1){//always overwrite -1
                curData[imageIndex]=curPixValue
            }else{
                if(curPixValue<=-2){//only overwrite existing glitches
                    if(existingValue<=-2){
                        curData[imageIndex]=Math.max(existingValue,curPixValue)
                    }
                    continue
                }
                if(curPixValue!=-1){//write if not -1 (fully computed)
                    curData[imageIndex]=curPixValue
                }
            }
        }
    }
    var curIntBitmap=new Int32Array(curBitmap.data.buffer)
    for(var i=0;i<tileHeight;i++){
        for(var j=0;j<tileWidth;j++){
            var imageIndex=(i+tileOffY)*curWidth+(j+tileOffX)
            curIntBitmap[imageIndex]=paletteFunc(curData[imageIndex])
        }
    }
    rcontext.putImageData(curBitmap,0,0)

    for(var i=0;i<tileHeight;i++){//make renderer ignore already rendered points
        for(var j=0;j<tileWidth;j++){
            var imageIndex=(i+tileOffY)*curWidth+(j+tileOffX)
            if(curData[imageIndex]>=0){
                orbitIntArray[((tileHeight-1-i)*tileWidth+j)*4+3]=-1
            }
            if(curData[imageIndex]==-1&&curiters==maxiters){//max iters is fully rendered; do not rerender -1s
                orbitIntArray[((tileHeight-1-i)*tileWidth+j)*4+3]=-1
            }
        }
    }
}
function findNewRef(){//todo
    var glitchLoc=null;
    var maxGlitchIters=-1
    for(var i=0;i<tileHeight;i++){
        for(var j=0;j<tileWidth;j++){
            var cdata=curData[tileWidth*i+j]
            if(curData[tileWidth*i+j-1]>-2)continue
            if(curData[tileWidth*i+j-tileWidth]>-2)continue
            if(curData[tileWidth*i+j+1]>-2)continue
            if(curData[tileWidth*i+j+tileWidth]>-2)continue
            if(cdata<=-2){
                if(-2-cdata>maxGlitchIters){
                    glitchLoc=[j,i]//on canvas
                    maxGlitchIters=-2-cdata
                }
            }
        }
    }
    console.log("found with score ",maxGlitchIters)
    if(glitchLoc==null){
        console.log("no glitch")
        return
    }
    var glitchOffX=((glitchLoc[0]+0.5)/tileWidth*2-1)*curzoom
    var glitchOffY=-((glitchLoc[1]+0.5)/tileHeight*2-1)*curzoom
    console.log(glitchOffX,glitchOffY)
    var glitchPos=curpos.add(new BigComplex(glitchOffX,glitchOffY))
    curref=glitchPos
    genReference(curref)
    var orbitIntArray=new Int32Array(orbitArray.buffer)
    startRender()
}
//-0.7497201102120534 0.028404976981026727 0.0000152587890625
//-1.98547607421875 0 0.00006103515625
//-1.3691932896205354 0.005801304408481992 0.000030517578125
//-1.1662939453124996 0.24600864955357157 0.000030517578125 (quite glitchy)
//curx=-0.7497201102120534,cury=0.028404976981026727,curzoom=0.0000152587890625

//glcont.uniform2fv(offsetIndex,[curx,cury])
//glcont.uniform1f(scaleIndex,curzoom)
//glcont.drawArrays(glcont.TRIANGLE_FAN,0,4)
render()
