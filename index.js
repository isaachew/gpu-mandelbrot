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

uniform int renderediters;//make sure small otherwise GPU will crash
uniform int maxiters;
uniform highp sampler2D lastorbit;//information about previous iterations: x, y, exp, number of iterations
uniform highp sampler2D lastorbit2;//glitch detection
uniform highp sampler2D reference;//reference orbit
uniform highp sampler2D approxdata;//approx
uniform float glitchSensitivity;
uniform int renderflags;
layout(location=0) out vec4 outputColour;//colour
layout(location=1) out vec4 orbitInfo;//output x, y, exp, number of iterations
layout(location=2) out vec4 orbitInfo2;//output reference offset, derivative

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

struct approx_entry{
    exp_complex zderiv;
    exp_complex cderiv;
    int numiters;
};

approx_entry getApproxEntry(int iters){
    vec4 curValue1=texelFetch(approxdata,ivec2((iters*2)&16383,(iters*2)>>14),0);
    vec4 curValue2=texelFetch(approxdata,ivec2((iters*2+1)&16383,(iters*2+1)>>14),0);
    exp_complex zderiv=exp_complex(curValue1.xy,floatBitsToInt(curValue1.z));
    exp_complex cderiv=exp_complex(curValue2.xy,floatBitsToInt(curValue2.z));
    int nskipped=floatBitsToInt(curValue2.w);
    return approx_entry(zderiv,cderiv,nskipped);
}

void main(){
    vec4 posData=texelFetch(lastorbit,ivec2(gl_FragCoord.xy),0);
    vec4 posData2=texelFetch(lastorbit2,ivec2(gl_FragCoord.xy),0);
    exp_complex curpos=exp_complex(posData.xy,int(posData.z));
    if(posData.xy==vec2(0.0,0.0))curpos.exponent=-21474836;
    int olditers=floatBitsToInt(posData.w);
    if(olditers<0){//stopped already
        outputColour=vec4(intBitsToFloat(olditers),0.0,0.0,0.0);
        orbitInfo=posData;//don't do anything
        orbitInfo2=posData2;
        return;
    }
    bool escaped=false;
    int numiters=olditers;
    int refiteroff=floatBitsToInt(posData2.x);
    approx_entry approxdata;

    exp_complex curderiv=exp_complex(posData2.yz,floatBitsToInt(posData2.w));
    if(posData2.yz==vec2(0.0,0.0))curderiv.exponent=-21474836;

    bool isglitch=false;
    exp_complex floatexpPosition=tofloatexp(fractalPos);
    floatexpPosition.exponent+=numzooms;
    float lcrad=log2(length(floatexpPosition.mantissa))+float(floatexpPosition.exponent);

    for(int i=0;i<renderediters;i++){
        if(numiters>maxiters){//too many iters, no reference
            numiters=-1;
            break;
        }
        exp_complex curref=getRef(numiters-refiteroff);
        exp_complex unperturbed=add(curpos,curref);
        if(unperturbed.exponent>=10){//normal bailout
            escaped=true;
            break;
        }
        if(curref.exponent>=1){
            isglitch=true;
            numiters=-3;
            break;
        }

        float lrad_oldpos=log2(length(curpos.mantissa))+float(curpos.exponent);
        float lrad_unpert=log2(length(unperturbed.mantissa))+float(unperturbed.exponent);
        if(lrad_unpert<lrad_oldpos){
                //numiters+=23424;
                //break;
                refiteroff=numiters;//will be at 0 next iteration
                curpos=add(curpos,curref);
                curref=exp_complex(vec2(0.0,0.0),-21474836);
        }

        //exp_complex refoffset=mulpow2(1,mul(curref,curpos));
        int approxthreshold=curref.exponent-80;
        approxdata=getApproxEntry(numiters-refiteroff);
        bool do_bla=false;
        if((renderflags&2)!=0){
            do_bla=approxdata.numiters>0&&floatexpPosition.exponent<approxthreshold&&curpos.exponent<approxthreshold;
        }
        if(do_bla){
            if((renderflags&1)!=0)curderiv=mul(curderiv,approxdata.zderiv);
            curpos=add(mul(curpos,approxdata.zderiv),mul(floatexpPosition,approxdata.cderiv));
            numiters+=approxdata.numiters;

        }else{
            if((renderflags&1)!=0)curderiv=add(mulpow2(1,mul(curderiv,add(curpos,curref))),exp_complex(vec2(1.0,0.0),0));
            curpos=add(mul(add(mulpow2(1,curref),curpos),curpos),floatexpPosition);
            numiters++;
        }
    }
    if(escaped||numiters<0){//escaped or glitch
        if((renderflags&1)!=0){
            exp_complex curref=getRef(numiters-refiteroff);
            vec2 cmant=add(curpos,curref).mantissa;
            vec2 derivmant=curderiv.mantissa;
            derivmant.y=-derivmant.y;
            vec2 totdir=complexmul(cmant,derivmant);//z/z', direction
            float ycomp=totdir.y/length(totdir);
            outputColour=vec4(intBitsToFloat(numiters+(65536*int(atan(totdir.y,totdir.x)/3.1415926535*127.99+256.0)&16711680)),0.0,0.0,0.0);
        }else{
            outputColour=vec4(intBitsToFloat(numiters),0.0,0.0,0.0);
        }
    }else{
        highp int mone=-1;
        outputColour=vec4(intBitsToFloat(mone),0.0,0.0,0.0);
    }
    orbitInfo=vec4(curpos.mantissa.xy,float(curpos.exponent),intBitsToFloat(numiters));
    orbitInfo2=vec4(intBitsToFloat(refiteroff),curderiv.mantissa,intBitsToFloat(curderiv.exponent));
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

var tileWidth=512,tileHeight=512
var curWidth=1024,curHeight=1024
rcanv.width=curWidth,rcanv.height=curHeight
glcanv.width=tileWidth,glcanv.height=tileHeight
glcont.viewport(0,0,tileWidth,tileHeight)

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
var maxiters=16384
function genReference(cval){//write floatexp
    var farr=new Float32Array(Math.ceil(maxiters/16384)*16384*3)
    var zval=new BigComplex(0,0);

    curtex=farr
    var calcStart=performance.now()
    //var occurred=new Map()
    //var period=null
    var escaped=null
    for(var i=0;i<maxiters;i++){
        var [zx,zy,zexp]=zval.toFloatexp()
        farr[i*3]=zx;
        farr[i*3+1]=zy;
        farr[i*3+2]=zexp;
        if(escaped==null){
            try{
                zval=zval.mul(zval).add(cval)
            }catch{
                escaped=i
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
    var calcEnd=performance.now()
    console.log((calcEnd-calcStart)+" ms to calc "+(escaped==null?maxiters:escaped)+" iterations")
    if(useBLA)createApproxTex()
}
function complexmul(a,b){
    return [a[0]*b[0]-a[1]*b[1],a[0]*b[1]+a[1]*b[0]]
}
function complexadd(a,b){
    return [a[0]+b[0],a[1]+b[1]]
}
function complexsub(a,b){
    return [a[0]-b[0],a[1]-b[1]]
}
function complexrecip(a){
    var factor=Math.floor(Math.log2(Math.hypot(...a)))
    var dvd=[a[0]/(2**factor),a[1]/(2**factor)]
    var res=[dvd[0]/(dvd[0]*dvd[0]+dvd[1]*dvd[1]),-dvd[1]/(dvd[0]*dvd[0]+dvd[1]*dvd[1])]
    res[0]/=2**factor
    res[1]/=2**factor
    return res
}
function toFloatexp([x,y]){
    var factor=Math.floor(Math.log2(Math.hypot(x,y)))
    if(Number.isNaN(factor))factor=-214748364
    return [x*(2**-factor),y*(2**-factor),factor]
}
//texture for approximation information
var approxtex=glcont.createTexture()
glcont.activeTexture(glcont.TEXTURE6)
glcont.bindTexture(glcont.TEXTURE_2D,approxtex)
enableTexture()
//reference is in texture unit 6
glcont.uniform1i(glcont.getUniformLocation(mandelProgram,"approxdata"),6)

function createApproxTex(){
    var approxData=new Float32Array(Math.ceil(maxiters*2/16384)*16384*4)//floatexp, num iters skipped
    var intApproxData=new Int32Array(approxData.buffer)
    var zval=curref;
    var cval=curref;
    var zderiv=[1,0]
    var cderiv=[0,0]
    var zderivs=[[0,0],zderiv]
    var cderivs=[[0,0],cderiv]
    var zmags=[0,zval.toFloatexp()[2]]

    var iterstack=[]
    curtex2=approxData
    var calcStart=performance.now()
    //var occurred=new Map()
    //var period=null
    var escaped=null
    var maxSkipDist=0
    for(var i=2;i<maxiters;i++){
        var fzval=zval.toFloats()
        zderiv=complexmul(complexmul(zderiv,[2,0]),fzval)
        //derivative of z_i given z_1, with respect to z_1 or c
        //console.log(zderiv)
        zderivs.push(zderiv)
        if(i%10000==0)console.log(i+" iters (deriv)")
        if((zderiv[0]==0&&zderiv[1]==0)||!Number.isFinite(zderiv[0]+zderiv[1])){
            console.log("overflow/underflow")
            break
        }
        if(escaped==null){
            try{
                zval=zval.mul(zval).add(cval)
            }catch{
                escaped=i
            }
        }
        var feval=zval.toFloatexp()
        var curlmag=feval[2]+Math.log2(Math.hypot(feval[0],feval[1]))
        zmags.push(curlmag)
        var curdmag=Math.log2(Math.hypot(zderiv[0],zderiv[1]))
        //curdmag/curlmag is the relative error
        //when higher, more error
        while(iterstack.length&&(curdmag-curlmag)>iterstack[iterstack.length-1][0]){
            var liters=iterstack.pop()
            var stopIter=i
            var srecips=[0,0]
            var cddiff=[0,0]
            var lliters=zmags[liters[1]]
            for(var j=liters[1]+1;j<=i;j++){//temporary quadratic complexity
                var caddn=complexrecip(zderivs[j])
                if(maxSkipDist==7)console.log(zderivs[j],caddn)
                srecips=complexadd(srecips,caddn)
                cddiff=complexmul(srecips,zderivs[j])
                var curcmag=Math.log2(Math.hypot(cddiff[0],cddiff[1]))
                if(curcmag+lliters>40+curlmag){
                    stopIter=j
                    break
                }
            }
            var zddiff=complexmul(zderivs[stopIter],complexrecip(zderivs[liters[1]]))

            var flexp_zdiff=toFloatexp(zddiff)
            var flexp_cdiff=toFloatexp(cddiff)
            approxData[liters[1]*8]=flexp_zdiff[0]
            approxData[liters[1]*8+1]=flexp_zdiff[1]
            intApproxData[liters[1]*8+2]=flexp_zdiff[2]
            approxData[liters[1]*8+4]=flexp_cdiff[0]
            approxData[liters[1]*8+5]=flexp_cdiff[1]
            intApproxData[liters[1]*8+6]=flexp_cdiff[2]
            intApproxData[liters[1]*8+7]=stopIter-liters[1]
            if(stopIter-liters[1]>maxSkipDist){
                console.log("skip "+(stopIter-liters[1]))
                maxSkipDist=stopIter-liters[1]
            }
        }
        iterstack.push([(curdmag-curlmag),i])
        /*
        if(occurred.has(""+[zx,zy])&&period==null){
            console.log("found",occurred.get(""+[zx,zy]),i)
            period=occurred.get(""+[zx,zy])-i
        }
        occurred.set(""+[zx,zy],i)
        */
    }
    console.log(maxSkipDist+" iters max skipped")
    glcont.activeTexture(glcont.TEXTURE6)
    glcont.texImage2D(glcont.TEXTURE_2D,0,glcont.RGBA32F,Math.min(maxiters*2,16384),Math.ceil(maxiters*2/16384),0,glcont.RGBA,glcont.FLOAT,approxData)
    var calcEnd=performance.now()
    console.log((calcEnd-calcStart)+" ms to calc "+(escaped==null?maxiters:escaped)+" iterations")
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
var fixedFactor=960n
function getDecimalValue(num,digits=Number(fixedFactor)+1){
    var st=""
    if(num<0n){
        num=-num
        st+="-"
    }
    var roundFactor=1n<<(fixedFactor-1n)//round
    for(var i=0;i<digits-1;i++)roundFactor/=10n
    num+=roundFactor
    for(var i=0;i<digits;i++){
        var nump=num>>fixedFactor
        st+=nump
        if(i==0)st+="."
        num-=nump<<fixedFactor
        num*=10n
    }
    return st
}
function fromDecimalValue(val){
    val=val.replace(/[^\-0-9.]/g,"")
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
var useBLA=false
genReference(new BigComplex(0,0))
var swapTextures=false

var blackArray=new Float32Array(tileWidth*tileHeight*4)//to reset to black
var orbitArray=new Float32Array(tileWidth*tileHeight*4)//to set orbit
var orbitIntArray=new Int32Array(orbitArray.buffer)
var renderStart=0

var tileOffX=300
var tileOffY=300

var readBuffer=new Uint8Array(4096)//where readpixels
var willRender=false
var lastPause=0
function startRender(){//start rendering a tile in WebGL
    curstepiters=100
    numReferences++
    if(curzoom<=1e-270){
        console.log("limit")
        curzoom=1e-270
    }
    curiters=0
    var pnow=performance.now()

    var fcoords=curpos.sub(curref).toFloats()
    var clscale=Math.floor(Math.log2(curzoom))
    var ciscale=curzoom*2**-clscale
    //console.log("offset ",[fcoords[0]*2**-clscale,fcoords[1]*2**-clscale])
    console.log("scale ",ciscale)
    console.log("iters ",maxiters)
    console.log("zooms ",clscale)
    console.log("sensitivity ",Math.log2(glitchSensitivity/curzoom))
    glcont.useProgram(mandelProgram)
    var curOffset=[fcoords[0]*2**-clscale,fcoords[1]*2**-clscale]
    curOffset[0]+=2*(tileOffX+tileWidth/2-curWidth/2)/curWidth*ciscale
    curOffset[1]-=2*(tileOffY+tileHeight/2-curHeight/2)/curWidth*ciscale
    glcont.uniform2fv(offsetIndex,curOffset)

    glcont.uniform1f(scaleIndex,ciscale*tileWidth/curWidth)
    glcont.uniform1i(glcont.getUniformLocation(mandelProgram,"renderediters"),Math.min(maxiters,maxstepiters))
    glcont.uniform1i(glcont.getUniformLocation(mandelProgram,"maxiters"),maxiters)
    glcont.uniform1i(glcont.getUniformLocation(mandelProgram,"numzooms"),clscale)
    glcont.uniform1f(sensitivityIndex,Math.log2(glitchSensitivity/curzoom))
    lastCanvasWrite=0
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
    if(!willRender)renderStep()
}

function renderStep(){
    willRender=false
    var renderediters=Math.min(curstepiters,maxiters-curiters)
    if(renderediters==0){
        var renderEnd=performance.now()
        console.log(`tile ${tileNum} rendered in ${renderEnd-renderStart} ms`)
        writeTile()
        tileNum++
        setTimeout(renderTile)
        return
    }
    var drawStart=performance.now()
    glcont.useProgram(mandelProgram)
    glcont.uniform1i(glcont.getUniformLocation(mandelProgram,"renderediters"),renderediters)
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
    //console.log(drawEnd-drawStart+"ms for "+renderediters+" iterations")
    var curTime=performance.now()
    if(curTime-lastCanvasWrite>2000){
        console.log("canvas")
        writeTile()
        lastCanvasWrite=performance.now()
    }
    swapTextures=!swapTextures
    curiters+=renderediters
    numRenderedIters.textContent=curiters
    if(curTime-lastPause>20){
        lastPause=curTime
        willRender=true
        setTimeout(renderStep)
    }else{
        renderStep()
    }
}

var curBitmap=rcontext.createImageData(curWidth,curHeight)
var curData=new Int32Array(curWidth*curHeight)
var curDataByte=new Uint8Array(curData.buffer)
function resizeImage(){
    rcanv.width=curWidth
    rcanv.height=curHeight
    curBitmap=rcontext.createImageData(curWidth,curHeight)
    curData=new Int32Array(curWidth*curHeight)
    curDataByte=new Uint8Array(curData.buffer)
}

var pixelsAffected=0
var numReferences=0
var tileNum=0
function resetRender(){
    for(var i=0;i<curData.length;i++){
        curData[i]=-2
    }
}
function resetTile(){

    for(var i=0;i<tileHeight;i++){
        for(var j=0;j<tileWidth;j++){
            orbitIntArray[(i*tileWidth+j)*4+3]=0
        }
    }
    for(var i=0;i<tileHeight;i++){//make renderer ignore already rendered points
        for(var j=0;j<tileWidth;j++){
            var imageIndex=(i+tileOffY)*curWidth+(j+tileOffX)
            var outOfBounds=(i+tileOffY>=curHeight)||(j+tileOffX>=curWidth)
            if(outOfBounds||curData[imageIndex]>=-1){
                orbitIntArray[((tileHeight-1-i)*tileWidth+j)*4+3]=-2
            }
        }
    }
}
var palette={"stops":[{"position":0,"colour":[138,220,255]},{"position":0.12235491071428571,"colour":[47,93,167]},{"position":0.3587109375,"colour":[237,237,237]},{"position":0.6516127232142858,"colour":[16,174,213]},{"position":0.8173604910714286,"colour":[48,103,145]},{"position":1,"colour":[138,220,255]}],"length":600}
function paletteFunc(x){
    if(x==-1)return -16777216//in set
    if(x==-2)return -16777216//not fully computed, may be in set
    if(x<-2)return -1
    if(!isFinite(x))return -16777216
    let progress=x%palette.length/palette.length
    let palind=palette.stops.findIndex(a=>a.position>progress)
    let colprog=(progress-palette.stops[palind-1].position)/(palette.stops[palind].position-palette.stops[palind-1].position)
    let cr=palette.stops[palind].colour[0]*colprog+palette.stops[palind-1].colour[0]*(1-colprog)
    let cg=palette.stops[palind].colour[1]*colprog+palette.stops[palind-1].colour[1]*(1-colprog)
    let cb=palette.stops[palind].colour[2]*colprog+palette.stops[palind-1].colour[2]*(1-colprog)
    return (cb<<16)|(cg<<8)|cr|-16777216
}
function writeTile(){//write tile to array
    var pixels=new Uint8Array(tileWidth*tileHeight*4)
    glcont.readPixels(0,0,tileWidth,tileHeight,glcont.RGBA,glcont.UNSIGNED_BYTE,pixels)
    var intPixels=new Int32Array(pixels.buffer)
    for(var i=0;i<tileHeight;i++){
        for(var j=0;j<tileWidth;j++){
            var curPixValue=intPixels[(tileHeight-1-i)*tileWidth+j]
            var imageIndex=(i+tileOffY)*curWidth+(j+tileOffX)
            var existingValue=curData[imageIndex]
            if(curPixValue==-2){//intentionally not calculated
                continue
            }
            if(existingValue==-2){//always overwrite -2 unless -1 (not computed)
                if(curPixValue!=-1||curiters==maxiters)curData[imageIndex]=curPixValue
            }else{
                if(curPixValue<=-3){//only overwrite existing glitches/not computed
                    if(existingValue<=-2){
                        curData[imageIndex]=Math.max(existingValue,curPixValue)
                    }
                    continue
                }
                if(curPixValue!=-1||curiters==maxiters){//write if not -1 (fully computed) or if -1 and max iters (in set)
                    curData[imageIndex]=curPixValue
                }
            }
        }
    }
    for(var i=0;i<tileHeight;i++){//make renderer ignore already rendered points
        for(var j=0;j<tileWidth;j++){
            var imageIndex=(i+tileOffY)*curWidth+(j+tileOffX)
            if(curData[imageIndex]>=-1){
                orbitIntArray[((tileHeight-1-i)*tileWidth+j)*4+3]=-2
            }
        }
    }
    toCanvas()
}
function toCanvas(){//write tile to canvas
    var curImgData=rcontext.createImageData(tileWidth,tileHeight)
    var curImgInts=new Int32Array(curImgData.data.buffer)
    var curIntBitmap=new Int32Array(curBitmap.data.buffer)
    var realTileWidth=Math.min(tileWidth,curWidth-tileOffX)
    var realTileHeight=Math.min(tileHeight,curHeight-tileOffY)
    for(var i=0;i<realTileHeight;i++){
        for(var j=0;j<realTileWidth;j++){
            var imageIndex=(i+tileOffY)*curWidth+(j+tileOffX)
            curIntBitmap[imageIndex]=paletteFunc(curData[imageIndex])
            curImgInts[i*tileWidth+j]=paletteFunc(curData[imageIndex])
        }
    }
    rcontext.putImageData(curImgData,tileOffX,tileOffY)
}
function findNewRef(){//remove glitches with size < 15
    var pointArray=new Uint32Array(curWidth*curHeight)//points that are visited
    var pointSet=[]
    var curPoints=[]//points to dfs
    var glitchSize=0
    var glitchLoc=null
    for(var i=0;i<curHeight;i++){
        for(var j=0;j<curWidth;j++){
            var coordIndex=i*curWidth+j
            if(curData[coordIndex]<-2&&pointArray[coordIndex]==0){
                pointSet=[]
                curPoints.push([j,i]);
                while(curPoints.length){
                    var curPoint=curPoints.pop();
                    if(curPoint[0]<0||curPoint[0]>=curWidth)continue
                    if(curPoint[1]<0||curPoint[1]>=curHeight)continue
                    var curCoordIndex=curPoint[1]*curWidth+curPoint[0]
                    if(curData[curCoordIndex]>=-2)continue
                    if(pointArray[curCoordIndex]==0){
                        pointArray[curCoordIndex]=coordIndex+1
                        pointSet.push(curPoint)
                        curPoints.push([curPoint[0]+1,curPoint[1]])
                        curPoints.push([curPoint[0]-1,curPoint[1]])
                        curPoints.push([curPoint[0],curPoint[1]+1])
                        curPoints.push([curPoint[0],curPoint[1]-1])
                    }

                }
                if(pointSet.length<15){
                    for(var k of pointSet){
                        var pCoordIndex=k[1]*curWidth+k[0]
                        curData[pCoordIndex]=1234567
                    }

                }else if(pointSet.length>glitchSize){
                    var avgPoint=[0,0]
                    for(var k of pointSet){
                        avgPoint[0]+=k[0]
                        avgPoint[1]+=k[1]
                    }
                    avgPoint[0]/=pointSet.length
                    avgPoint[0]|=0
                    avgPoint[1]/=pointSet.length
                    avgPoint[1]|=0
                    if(pointArray[avgPoint[1]*curWidth+avgPoint[0]]==coordIndex+1){
                        console.log("avg point in glitch")
                        glitchLoc=avgPoint
                    }else{
                        console.log("avg point not in glitch")
                        glitchLoc=pointSet[pointSet.length*Math.random()|0]
                    }
                    glitchSize=pointSet.length
                }
            }

        }
    }
    if(glitchLoc==null){
        console.log("no glitch")
        return
    }
    rcontext.strokeStyle="red"
    rcontext.lineWidth=10
    rcontext.beginPath()
    rcontext.rect(glitchLoc[0]-20,glitchLoc[1]-20,40,40)
    rcontext.stroke()
    var glitchOffX=((glitchLoc[0]+0.5-curWidth/2)/curWidth*2)*curzoom
    var glitchOffY=-((glitchLoc[1]+0.5-curHeight/2)/curWidth*2)*curzoom
    console.log(glitchOffX,glitchOffY)
    var glitchPos=curpos.add(new BigComplex(glitchOffX,glitchOffY))
    curref=glitchPos
    genReference(curref)
    var orbitIntArray=new Int32Array(orbitArray.buffer)
    tileNum=0
    setTimeout(renderTile)
}

function renderTile(){
    var horizTiles=Math.ceil(curWidth/tileWidth)
    var vertTiles=Math.ceil(curHeight/tileHeight)
    console.log(horizTiles)
    if(tileNum>=horizTiles*vertTiles){
        return
    }
    tileOffX=(tileNum%horizTiles)*tileWidth
    tileOffY=Math.floor(tileNum/horizTiles)*tileHeight
    resetTile()
    startRender()
}
function render(){
    resetRender()
    tileNum=0
    renderTile()
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
        tileNum=0
        renderTile()
    }
    if(e.key=="r"){
        curref=curpos.add(new BigComplex(curox,curoy));
        genReference(curref)
        tileNum=0
        renderTile()
    }
    if(e.key=="e"){
        curval=(curval+1)%4
        glcont.uniform1i(glcont.getUniformLocation(mandelProgram,"renderflags"),curval)
        render()
    }
    if(e.key=="x"){
        render()
    }
})
document.getElementById("maxIterations").addEventListener("change",a=>{
    maxiters=+a.target.value
    genReference(curref)
})
document.getElementById("gotoLocation").addEventListener("click",a=>{
    var nxpos=document.getElementById("xPosition").value
    var nypos=document.getElementById("yPosition").value
    curpos=new BigComplex(nxpos,nypos)
    var nzoom=document.getElementById("zoomWidth").value
    if(nzoom)curzoom=+nzoom
    render()
})

document.getElementById("downloadButton").addEventListener("click",e=>{
    rcanv.toBlob(a=>{
        objurl=URL.createObjectURL(a)
        var downloadLink=document.createElement("a")
        downloadLink.download="render.png"
        downloadLink.href=objurl
        downloadLink.click()
    })
})
window.addEventListener("beforeunload",function(e){
    e.preventDefault()//warn when closing
})
//-0.7497201102120534 0.028404976981026727 0.0000152587890625
//-1.98547607421875 0 0.00006103515625
//-1.3691932896205354 0.005801304408481992 0.000030517578125
//-1.1662939453124996 0.24600864955357157 0.000030517578125 (quite glitchy)
//curx=-0.7497201102120534,cury=0.028404976981026727,curzoom=0.0000152587890625

//glcont.uniform2fv(offsetIndex,[curx,cury])
//glcont.uniform1f(scaleIndex,curzoom)
//glcont.drawArrays(glcont.TRIANGLE_FAN,0,4)
render()
