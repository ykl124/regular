var _ = require("../util.js");
var node = require("./node.js");
var Lexer = require("./Lexer.js");
var varName = _.varName;
var ctxName = _.randomVar('c');
var isPath = _.makePredicate("STRING IDENT NUMBER");
var isKeyWord = _.makePredicate("true false undefined null this Array Date JSON Math NaN RegExp decodeURI decodeURIComponent encodeURI encodeURIComponent parseFloat parseInt Object");
var exports = {_path: _._path, _r: _._range}


function Parser(input, opts){
  opts = opts || {};
  this.input = input;
  this.tokens = new Lexer(input, opts).lex();
  this.pos = 0;
  this.length = this.tokens.length;
}


// @TODO : to detect prop cache length;
var cache = Parser.cache = _.cache(1000);
var op = Parser.prototype;


op.parse = function(str){
  this.pos = 0;
  return this.program();
}

op.ll =  function(k){
  k = k || 1;
  if(k < 0) k = k + 1;
  var pos = this.pos + k - 1;
  if(pos > this.length - 1){
      return this.tokens[this.length-1];
  }
  return this.tokens[pos];
}
  // lookahead
op.la = function(k, value){
  return (this.ll(k) || '').type;
}

op.match = function(type, value){
  if(!(ll = this.eat(type, value))){
    var ll  = this.ll();
    this.error('expect [' + type + (value == null? '':':'+ value) + ']" -> got "[' + ll.type + (value==null? '':':'+ll.value) + ']', ll.pos)
  }else{
      return ll;
  }
}

// @TODO
op.error = function(msg, pos){
  console.log(this.ll())
  throw "Parse Error: " + msg +  ':\n' + _.trackErrorPos(this.input, pos != null? pos: this.ll().pos);
}

op.next = function(k){
  k = k || 1;
  this.pos += k;
}
op.eat = function(type, value){
  var ll = this.ll();
  if(typeof type !== 'string'){
    for(var len = type.length ; len--;){
      if(ll.type == type[len]) {
        this.next();
        return ll;
      }
    }
  }else{
    if( ll.type == type 
        && (typeof value == 'undefined' || ll.value == value) ){
       this.next();
       return ll;
    }
  }
  return false;
}

op.isEmpty = function(value){
  return !value || value.length;
}




// program
//  :EOF
//  | (statement)* EOF
op.program = function(){
  var statements = [], statement, ll = this.ll();
  while(ll.type !== 'EOF' && ll.type !=='TAG_CLOSE'){
    statements.push(this.statement());
    ll = this.ll();
  }
  return statements;
}

op.statements = function(until){
  var ll, body = [];
  while( !(ll = this.eat('CLOSE', until)) ){
    body.push(this.statement());
  }
  return body;
}

// statement
//  : xml
//  | jst
//  | text
op.statement = function(){
  var ll = this.ll(),la;
  switch(ll.type){
    case 'NAME':
    case 'TEXT':
      var text = ll.value;
      this.next();
      while(ll = this.eat(['NAME', 'TEXT'])){
        text += ll.value;
      }
      return {type:'text', text: text};
    case 'TAG_OPEN':
      return this.xml();
    case 'OPEN': 
      return this.directive();
    case 'EXPR_OPEN':
      return this.interplation();
    case 'PART_OPEN':
      return this.template();
    default:
      this.error('Unexpected token: '+ this.la())
  }
}

// xml 
// stag statement* TAG_CLOSE?(if self-closed tag)
op.xml = function(){
  var name, attrs, children, selfClosed;
  name = this.match('TAG_OPEN').value;
  attrs = this.attrs();
  selfClosed = this.eat('/')
  this.match('>')
  if( !selfClosed && !_.isVoidTag(name) ){
    children = this.program();
    if(!this.eat('TAG_CLOSE', name)) this.error('expect </'+name+'> got'+ 'no matched closeTag')
  }
  return node.element(name, attrs, children);
}

// stag     ::=    '<' Name (S attr)* S? '>'  
// attr    ::=     Name Eq attvalue
op.attrs = function(){


  var attrs = [], attr, ll = this.ll();
  //   case 'OPEN': 
  //     return this.directive();
  //   case 'NAME':
  //   case '&':
  //     attr = { name: ll.value }
  //     if( this.eat("=") ) attr.value = this.attvalue();

  // switch(ll.type){
  //   case: 
  // }

  while( ll = this.eat(["NAME", "&"]) ){
    attr = { name: ll.value }
    if( this.eat("=") ) attr.value = this.attvalue();

    attrs.push( attr );
  }
  return attrs;
}

// attvalue
//  : STRING  
//  | NAME
op.attvalue = function(){
  var ll = this.ll();
  switch(ll.type){
    case "NAME":
    case "UNQ":
    case "STRING":
      this.next();
      var value = ll.value;
      if(value.type !== "expression" && ~value.indexOf('{{')){
        var constant = true;
        var parsed = new Parser(value, {mode:2}).parse();
        for(var i =0, len = parsed.length; i < len; i++ ){
          var item = parsed[i];
          if(item.get && !item.constant) constant = false;
        }
        var get = function(self){
          var res= parsed.map(function(item){
            if(item && item.get){
              return item.get(self);
            }
            else return item.text || "";
          }).join("");
          return res;
        }
        value = node.expression(get, null, constant);
      }
      return value;
    case "EXPR_OPEN":
      return this.interplation();
    default:
      this.error('Unexpected token: '+ this.la())
  }
  return ll.value;
}


// {{#}}
op.directive = function(name){
  name = name || (this.ll().value);
  if(typeof this[name] == 'function'){
    return this[name]()
  }else{
    this.error('Undefined directive['+ name +']');
  }
}

// {{}}
op.interplation = function(){
  var nowatch = this.match('EXPR_OPEN').nowatch;
  var res = this.expression(true);
  this.match('END');
  return res;
}

// {{~}}
op.template = function(){
  this.next();
  var content = this.expression();
  this.match('END');
  return node.template(content);
}

// {{#if}}
op["if"] = function(){
  this.next();
  var test = this.expr();
  var consequent = [], alternate=[];

  var container = consequent;

  this.match('END');

  var ll, type, close;
  while( ! (close = this.eat('CLOSE')) ){
    ll = this.ll();
    if(ll.type == 'OPEN'){
      switch(ll.value){
        case 'else':
          container = alternate;
          this.next();
          this.match('END');
          break;
        case 'elseif':
          alternate.push(this["if"]())
          return node['if'](test, consequent, alternate)
        default:
          container.push(this.statement())
      }
    }else{
      container.push(this.statement());
    }
  }
  // if statement not matched
  if(close.value !== "if") this.error('Unmatched if directive')
  return node["if"](test, consequent, alternate);
}


// @mark   mustache syntax have natrure dis, canot with expression
// {{#list}}
op.list = function(){
  this.next();
  // sequence can be a list or hash
  var sequence = this.expression(), variable, body, ll;
  var consequent = [], alternate=[];
  var container = consequent;

  this.match('IDENT', 'as');

  variable = this.match('IDENT').value;

  this.match('END');

  while( !(ll = this.eat('CLOSE')) ){
    if(this.eat('OPEN', 'else')){
      container =  alternate;
      this.match('END');
    }else{
      container.push(this.statement());
    }
  }
  if(ll.value !== 'list') this.error('expect ' + '{/list} got ' + '{/' + ll.value + '}', ll.pos );
  return node.list(sequence, variable, consequent, alternate);
}


// @TODO:
op.expression = function(){
  var expression = this.expr();
  return expression;
}

op.expr = function(filter){
  this.depend = [];
  var buffer = this.filter(), set, get;
  var body = buffer.get || buffer;
  
  var prefix =  "var "+ctxName+"=context.context||context;"+ (this.depend.length? "var "+varName+"=context.data;" : "");
  var get = new Function("context", prefix + "return (" + body + ")");


  if(buffer.set) var set =  new Function("context", _.setName ,
    prefix +";return (" + buffer.set + ")" 
    );

  if(!this.depend.length){
    // means no dependency
    return node.expression(get)
  }else{
    return node.expression(get, set, !this.depend || !this.depend.length )
  }
  return {}
}


// filter
// assign ('|' filtername[':' args]) * 
op.filter = function(){
  var left = this.assign();
  var ll = this.eat('|');
  var buffer, attr;
  if(ll){
    buffer = [
      "(function(data){", 
          "var ", attr = _.randomVar('f'), "=", left.get, ";"]
    do{

      buffer.push(attr + " = "+ctxName+"._f('" + this.match('IDENT').value+ "')(" + attr) ;
      if(this.eat(':')){
        buffer.push(", "+ this.arguments("|").join(",") + ");")
      }else{
        buffer.push(');');
      }

    }while(ll = this.eat('|'));
    buffer.push("return " + attr + "})()");
    return this.getset(buffer.join(""));
  }
  return left;
}

// assign
// left-hand-expr = condition
op.assign = function(){
  var left = this.condition(), ll;
  if(ll = this.eat(['=', '+=', '-=', '*=', '/=', '%='])){
    if(!left.set) this.error('invalid lefthand expression in assignment expression');
    return this.getset('(' + left.get + ll.type  + this.condition().get + ')', left.set);
  }
  return left;
}

// or
// or ? assign : assign
op.condition = function(){

  var test = this.or();
  if(this.eat('?')){
    return this.getset([test.get + "?", 
      this.assign().get, 
      this.match(":").type, 
      this.assign().get].join(""));
  }

  return test;
}

// and
// and && or
op.or = function(){

  var left = this.and();

  if(this.eat('||')){
    return this.getset(left.get + '||' + this.or().get);
  }

  return left;
}
// equal
// equal && and
op.and = function(){

  var left = this.equal();

  if(this.eat('&&')){
    return this.getset(left.get + '&&' + this.and().get);
  }
  return left;
}
// relation
// 
// equal == relation
// equal != relation
// equal === relation
// equal !== relation
op.equal = function(){
  var left = this.relation(), ll;
  // @perf;
  if( ll = this.eat(['==','!=', '===', '!=='])){
    return this.getset(left.get + ll.type + this.equal().get);
  }
  return left
}
// relation < additive
// relation > additive
// relation <= additive
// relation >= additive
// relation in additive
op.relation = function(){
  var left = this.additive(), la,ll;
  // @perf
  if(ll = (this.eat(['<', '>', '>=', '<=']) || this.eat('IDENT', 'in') )){
    return this.getset(left.get + ll.value + this.relation().get);
  }
  return left
}
// additive :
// multive
// additive + multive
// additive - multive
op.additive = function(){
  var left = this.multive() ,ll;
  if(ll= this.eat(['+','-']) ){
    return this.getset(left.get + ll.value + this.additive().get);
  }
  return left
}
// multive :
// unary
// multive * unary
// multive / unary
// multive % unary
op.multive = function(){
  var left = this.range() ,ll;
  if( ll = this.eat(['*', '/' ,'%']) ){
    return this.getset(left.get + ll.type + this.multive().get);
  }
  return left;
}

op.range = function(){
  var left = this.unary(), ll, right;

  if(ll = this.eat('..')){
    right = this.unary();
    var body = ctxName + '._r(' +left.get + ','+ right.get + ')'
    return this.getset(body);
  }

  return left;
}



// lefthand
// + unary
// - unary
// ~ unary
// ! unary
op.unary = function(){
  var ll;
  if(ll = this.eat(['+','-','~', '!'])){
    return this.getset('(' + ll.type + this.unary().get + ')') ;
  }else{
    return this.member()
  }
}

// call[lefthand] :
// member args
// member [ expression ]
// member . ident  

op.member = function(base, last, pathes){
  // @TODO depend must deregular in this step
  var ll, path, value;
  var first = !base;

  if(!base){ //first
    path = this.primary();
    var type = typeof path;
    if(type === 'string'){ // no keyword ident
      pathes = [];
      if(path === '$self'){ // $self.1
        pathes.push('*');
        base = varName;
      }else{ // keypath **
        pathes.push(path);
        last = path;
        base = varName + "['" + path + "']";
      }
    }else{ //Primative Type
      if(path.get === 'this'){
        base = ctxName;
        pathes = ['this'];
      }else{
        pathes = null;
        base = path.get;
      }
      
    }
  }else{ // not first enter
    if(typeof last === 'string' && isPath( last) ){ // is valid path
      pathes.push(last);
    }else{
      if(pathes && pathes.length) this.depend.push(pathes);
      pathes = null;
    }
  }
  if(ll = this.eat(['[', '.', '('])){
    switch(ll.type){
      case '.':
          // member(object, property, computed)
        var tmpName = this.match('IDENT').value;
          base += "['" + tmpName + "']";
        return this.member( base, tmpName, pathes );
      case '[':
          // member(object, property, computed)
        path = this.assign();
        if(pathes && pathes.length){
          base = ctxName + "._path("+base+", "+ path.get + ")";
        }else{
          base += "['" + path.get + "']";
        }        
        this.match(']')
        return this.member(base, path, pathes);
      case '(':
        // call(callee, args)
        var args = this.arguments().join(',');
        base = "(typeof ("+ base + ") !=='function'?" + base+"(" + args +"):" + base + (".call(" + ctxName + (args? "," + args : "")  + "))");
        this.match(')')
        return this.member(base, null, pathes);
    }
  }
  if(pathes && pathes.length) this.depend.push(pathes);
  var res =  {get: base};
  if(last) res.set = base + '=' + _.setName;
  return res;
}

/**
 * 
 */
op.arguments = function(end){
  end = end || ')'
  var args = [], ll;
  do{
    if(this.la() !== end){
      args.push(this.assign().get)
    }
  }while( this.eat(','));
  return args
}


// primary :
// this 
// ident
// literal
// array
// object
// ( expression )

op.primary = function(){
  var ll = this.ll();
  switch(ll.type){
    case "{":
      return this.object();
    case "[":
      return this.array();
    case "(":
      return this.paren();
    // literal or ident
    case 'STRING':
      this.next();
      return this.getset("'" + ll.value + "'")
    case 'NUMBER':
      this.next();
      return this.getset(ll.value);
    case "IDENT":
      this.next();
      if(isKeyWord(ll.value)){
        return this.getset( ll.value );
      }
      return ll.value;
    default: 
      this.error('Unexpected Token: ' + ll.type);
  }
}

// object
//  {propAssign [, propAssign] * [,]}

// propAssign
//  prop : assign

// prop
//  STRING
//  IDENT
//  NUMBER

op.object = function(){
  var code = [this.match('{').type];

  var ll;
  while(true){
    ll = this.eat(['STRING', 'IDENT', 'NUMBER']);
    if(ll){
      code.push("'" + ll.value + "'" + this.match(':').type);
      code.push(this.assign().get);
      if(this.eat(",")) code.push(",");
    }else{
      code.push(this.match('}').type);
      break;
    }
  }
  return {get: code.join("")}
}

// array
// [ assign[,assign]*]
op.array = function(){
  var code = [this.match('[').type], item;
  while(item = this.assign()){
    code.push(item.get);
    if(this.eat(',')) code.push(",");
    else break;
  }
  code.push(this.match(']').type);
  return {get: code.join("")};
}

// '(' expression ')'
op.paren = function(){
  this.match('(');
  var res = this.filter()
  res.get = '(' + res.get + ')';
  this.match(')');
  return res;
}

op.getset = function(get, set){
  return {
    get: get,
    set: set
  }
}

//
op.flatenDepend = function(depend){
  for(var i = 0, len = depend.length; i < len; i++){

  }
}



module.exports = Parser;
