//var rcanv=document.getElementById("render-canvas")
//var rcontext=rcanv.getContext("2d")
var glcanv=document.getElementById("webgl-canvas")
var glcont=glcanv.getContext("webgl2",{preserveDrawingBuffer: true})
function createShader(context,type,program){
    var shader=context.createShader(type)
    context.shaderSource(shader,program)
    context.compileShader(shader)
    if(!context.getShaderParameter(shader,context.COMPILE_STATUS)){
        console.log("shader error:\n"+context.getShaderInfoLog(shader))
    }
    return shader
}
var vertShader=createShader(glcont,glcont.VERTEX_SHADER,`#version 300 es
precision highp float;
in vec2 position;//-1 to 1
uniform vec2 posOffset;
uniform float scale;
out vec2 fractalPos;
void main(){
    gl_Position=vec4(position,0.0,1.0);
    fractalPos=position*scale+posOffset;
}
`)
/*
f_(n+1)=(f_n+r_n)^2+c-r_(n+1)
      = f_n^2+2f_nr_n+r_n^2+c-r_n^2-r_c
      = f_n^2+2f_nr_n+f_c
f_0=r_0=0
*/
var fragShader=createShader(glcont,glcont.FRAGMENT_SHADER,`#version 300 es
precision highp float;
in vec2 fractalPos;
//uniform vec2 juliaPos;
uniform sampler2D reference;
uniform float glitchSensitivity;
uniform int paletteparam;
out vec4 outputColour;
vec4 palette(int iters){
    if(iters==-1)return vec4(0.0,0.0,0.0,1.0);
    vec3 fullbr=vec3(0,cos(float(iters)*0.2)*-0.5+0.7,cos(float(iters)*0.2)*0.2+0.7);
    fullbr*=cos(float(iters)*0.0085)*0.25+0.75;
    return vec4(fullbr,1.0);
}
vec2 getRef(int iters){
    return texelFetch(reference,ivec2(iters,0),0).xy;
}
vec2 complexmul(vec2 a,vec2 b){
    return vec2(a.x*b.x-a.y*b.y,a.x*b.y+a.y*b.x);
}
void main(){
    //gl_FragColor=vec4(texture2D(reference,fractalPos).xyz,1.0);

    vec2 curpos=vec2(0.0,0.0);
    int numIters=-1;
    bool isglitch=false;
    float curderiv=1.0;
    float minderiv=1e18;
    float maxderiv=1e18;
    float curerr=0.0;
    float minabs=5.0;
    //vec2 cderiv=vec2(0.0,0.0);
    for(int i=0;i<16384;i++){
        vec2 curref=getRef(i);
        float lcpos=length(curpos+curref);
        if(lcpos>2.0){
            numIters=i;
            break;
        }
        if(paletteparam==2){
            if(lcpos<0.01*length(curref)){
                numIters+=23424;
                break;
            }
        }
        if(i>0){
            curderiv*=2.0*lcpos;
        }
        vec2 refoffset=2.0*complexmul(curref,curpos);
        curpos=vec2(curpos.x*curpos.x-curpos.y*curpos.y,2.0*curpos.x*curpos.y)+refoffset+fractalPos;
        float cpref=length(curpos);
        //cderiv=2.0*complexmul(cderiv,curpos+curref)+vec2(1.0,0.0);

        curerr=max(curerr,cpref/curderiv);
        //curerr=length(cderiv);
        //if(curerr>1.0)curerr=1.0;
        //if(i>100){
            if(paletteparam==0){
                if(curerr>1.0/glitchSensitivity){
                    numIters+=23424;
                    break;
                }
            }
        //}
    }
    //if(isglitch)maxerr=1e18;
    //gl_FragColor=vec4(mod(float(numIters)*0.434,1.0),0.0,0.0,1.0);
    //gl_FragColor=vec4(mod(float(numIters)/16777216.0,1.0),mod(float(numIters)/65536.0,1.0),mod(float(numIters)*43.6231/256.0,1.0),1.0);

    outputColour=palette(numIters);
    outputColour.r=0.0;
    if(paletteparam==1){
        float mix=clamp(0.5+(log(curerr)+log(glitchSensitivity))/10.0,0.0,1.0);
        outputColour=(1.0-mix)*outputColour+mix*vec4(1.0,0.0,0.0,1.0);
    }
}
`)
function palette(iters){

}
console.time("hi")
console.log(performance.now())
var shaderProgram=glcont.createProgram()
glcont.attachShader(shaderProgram,vertShader)
glcont.attachShader(shaderProgram,fragShader)
glcont.linkProgram(shaderProgram);//finalise program

var positionIndex=glcont.getAttribLocation(shaderProgram,"position")
var offsetIndex=glcont.getUniformLocation(shaderProgram,"posOffset")
var scaleIndex=glcont.getUniformLocation(shaderProgram,"scale")
var sensitivityIndex=glcont.getUniformLocation(shaderProgram,"glitchSensitivity")
var refIndex=glcont.getUniformLocation(shaderProgram,"reference")


var positionBuffer=glcont.createBuffer()
glcont.bindBuffer(glcont.ARRAY_BUFFER,positionBuffer)
glcont.bufferData(glcont.ARRAY_BUFFER,new Float32Array([-1,-1,-1,1,1,1,1,-1]),glcont.STATIC_DRAW)
glcont.enableVertexAttribArray(positionIndex)//enable "position" attribute to be bound to a buffer
glcont.vertexAttribPointer(positionIndex,2,glcont.FLOAT,false,0,0)//how the data is read from buffer


glcont.useProgram(shaderProgram)

var ptex=glcont.createTexture()

glcont.activeTexture(glcont.TEXTURE0)
glcont.bindTexture(glcont.TEXTURE_2D,ptex)
glcont.uniform1i(refIndex,0)
function genReference(cx,cy){
    var farr=new Float32Array(32768)
    var [zx,zy]=[0,0];
    var occurred=new Map()
    var period=null
    for(var i=0;i<16384;i++){
        farr[i*2]=zx;
        farr[i*2+1]=zy;
        [zx,zy]=[zx*zx-zy*zy+cx,2*zx*zy+cy];
        if(occurred.has(""+[zx,zy])&&period==null){
            console.log("found",occurred.get(""+[zx,zy]),i)
            period=occurred.get(""+[zx,zy])-i
        }
        occurred.set(""+[zx,zy],i)
    }

    glcont.texImage2D(glcont.TEXTURE_2D,0,glcont.RG32F,16384,1,0,glcont.RG,glcont.FLOAT,farr)
}
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
glcont.texParameteri(glcont.TEXTURE_2D,glcont.TEXTURE_MIN_FILTER,glcont.NEAREST)
glcont.texParameteri(glcont.TEXTURE_2D,glcont.TEXTURE_MAG_FILTER,glcont.NEAREST)
glcont.texParameteri(glcont.TEXTURE_2D,glcont.TEXTURE_WRAP_S,glcont.CLAMP_TO_EDGE)
glcont.texParameteri(glcont.TEXTURE_2D,glcont.TEXTURE_WRAP_T,glcont.CLAMP_TO_EDGE)



glcont.uniform2fv(offsetIndex,[0,0])
glcont.uniform1f(scaleIndex,2)
glcont.drawArrays(glcont.TRIANGLE_FAN,0,4)
console.timeEnd("hi")
var fixedFactor=736n
function getDecimalValue(num,digits=Number(fixedFactor)+1){
    st=""
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
    rad(){
        return Math.hypot(...this.toFloats())
    }
}
var curpos=new BigComplex(0n,0n),curzoom=2,curval=0,glitchSensitivity=1/(2**24/1024*3)
var curref=new BigComplex(0n,1n<<fixedFactor)//e-6
genReference(new BigComplex(0,1))
glcont.uniform2fv(offsetIndex,curpos.sub(curref).toFloats())
glcont.uniform1f(scaleIndex,curzoom)
glcont.uniform1f(sensitivityIndex,glitchSensitivity/curzoom)
glcont.drawArrays(glcont.TRIANGLE_FAN,0,4)
function render(){
    if(curzoom<=1e-33){
        console.log("limit")
        curzoom=1e-33
    }

    var pnow=performance.now()

    glcont.uniform2fv(offsetIndex,curpos.sub(curref).toFloats())
    glcont.uniform1f(scaleIndex,curzoom)
    glcont.uniform1f(sensitivityIndex,glitchSensitivity/curzoom)
    glcont.drawArrays(glcont.TRIANGLE_FAN,0,4)
    var x=new Uint8Array(4096)
    glcont.readPixels(0,0,32,32,glcont.RGBA,glcont.UNSIGNED_BYTE,x)
    var anow=performance.now()
    console.log(anow-pnow,"ms")
}
document.getElementById("webgl-canvas").addEventListener("mousedown",e=>{
    var crect=e.target.getBoundingClientRect()
    var xoffset=(e.offsetX/(crect.right-crect.left)-0.5)*2*curzoom
    var yoffset=-(e.offsetY/(crect.bottom-crect.top)-0.5)*2*curzoom
    curpos=curpos.add(new BigComplex(xoffset,yoffset))
    if(e.button==0)curzoom/=2
    if(e.button==2)curzoom*=2
    render()
    e.preventDefault()
})
document.getElementById("webgl-canvas").addEventListener("contextmenu",e=>{
    e.preventDefault()
})
var curox,curoy;
document.getElementById("webgl-canvas").addEventListener("mousemove",e=>{
    var crect=e.target.getBoundingClientRect()
    curox=(e.offsetX/(crect.right-crect.left)-0.5)*2*curzoom
    curoy=-(e.offsetY/(crect.bottom-crect.top)-0.5)*2*curzoom
})
document.addEventListener("keydown",e=>{
    if(e.key=="a")curzoom/=2
    if(e.key=="b")curzoom*=2
    if(e.key=="p"){
        curref=curpos;
        genReference(curpos)
    }
    if(e.key=="r"){
        curref=curpos.add(new BigComplex(curox,curoy));
        genReference(curref)
        glcont.uniform1i(glcont.getUniformLocation(shaderProgram,"paletteparam"),0)
        curval=0
    }
    if(e.key=="e"){
        curval=(curval+1)%4
        glcont.uniform1i(glcont.getUniformLocation(shaderProgram,"paletteparam"),curval/**curzoom*/)
    }
    render()
})
function checkGlitches(){

}
//-0.7497201102120534 0.028404976981026727 0.0000152587890625
//-1.98547607421875 0 0.00006103515625
//-1.3691932896205354 0.005801304408481992 0.000030517578125
//-1.1662939453124996 0.24600864955357157 0.000030517578125 (quite glitchy)
//curx=-0.7497201102120534,cury=0.028404976981026727,curzoom=0.0000152587890625

//glcont.uniform2fv(offsetIndex,[curx,cury])
//glcont.uniform1f(scaleIndex,curzoom)
//glcont.drawArrays(glcont.TRIANGLE_FAN,0,4)
