/* -*- mode: javascript -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// This is source code for TypeScript 1.5 and node.js 0.10

/*
 * Usage:
 *   parlang input-file ...
 *
 * One output file will be produced for each input file.  Each input
 * file must have extension .xx.parlang, where x is typically js or
 * ts.  On output the .parlang suffix will be stripped.
 *
 * To compile:
 *   tsc -t ES5 -m commonjs parlang.ts
 *
 * An alternative to the ad-hoc and brittle macro expansion at some of
 * the later stages here is to emit macro definitions for sweet.js and
 * postprocess the output with that.
 */

/// <reference path='typings/node/node.d.ts' />

import fs = require("fs");

enum DefnKind {
    Class,
    Struct,
    Primitive
}

class Defn {
    size = 0;
    align = 0;

    constructor(public name:string, public kind:DefnKind) { }
}

class PrimitiveDefn extends Defn {
    constructor(name:string, size:number, public atomic:boolean) {
	super(name, DefnKind.Primitive);
	this.size = size;
	this.align = size;
    }

    get memory(): string {
	return "_mem_" + this.name;
    }
}

class UserDefn extends Defn {
    typeRef: StructDefn = null;
    map = null;
    live = false;
    checked = false;

    constructor(public file:string, public line:number, name:string, kind:DefnKind, public props:Prop[], public methods:Method[], public origin:number)  {
	super(name, kind);
    }

    findAccessibleFieldFor(operation:string, prop:string) {
	switch (operation) {
	case "get_":
	case "set_":
	case "ref_":
	    return this.map[prop];
	default:
	    return null;
	}
    }
}

class ClassDefn extends UserDefn {
    baseTypeRef: ClassDefn = null;
    className = "";		// Base1>Base2>name
    classId = 0;
    subclasses: ClassDefn[] = []; // direct proper subclasses
    vtable = null;

    constructor(file:string, line:number, name:string, public baseName:string, props:Prop[], methods:Method[], origin:number) {
	super(file, line, name, DefnKind.Class, props, methods, origin);
    }

    hasMethod(name:string):boolean {
	for ( var m of this.methods )
	    if (m.name == name)
		return true;
	return false;
    }
}

class VirtualMethodNameIterator {
    private i = 0;
    private inherited = false;
    private filter = {};

    constructor(private cls:ClassDefn) {}

    next(): [string,boolean] {
	for (;;) {
	    if (this.i == this.cls.methods.length) {
		if (!this.cls.baseTypeRef)
		    return ["", false];
		this.i = 0;
		this.cls = this.cls.baseTypeRef;
		this.inherited = true;
		continue;
	    }
	    var m = this.cls.methods[this.i++];
	    if (m.kind != MethodKind.Virtual) // In the future, we may have non-virtuals
		continue;
	    if (m.name == "init") // Not virtual
		continue;
	    if (this.filter.hasOwnProperty(m.name))
		continue;
	    this.filter[m.name] = true;
	    return [m.name, this.inherited];
	}
    }
}

class InclusiveSubclassIterator {
    private stack = [];

    constructor(cls:ClassDefn) {
	this.stack.push(cls);
    }

    next(): ClassDefn {
	if (this.stack.length == 0)
	    return null;
	var x = this.stack.pop();
	if (typeof x == "number") {
	    var xs = this.stack.pop();
	    var cls = xs[x++];
	    if (x < xs.length) {
		this.stack.push(xs);
		this.stack.push(x);
	    }
	    if (cls.subclasses.length > 0) {
		this.stack.push(cls.subclasses);
		this.stack.push(0);
	    }
	    return cls;
	}
	else {
	    if (x.subclasses.length > 0) {
		this.stack.push(x.subclasses);
		this.stack.push(0);
	    }
	    return x;
	}
    }
}

class StructDefn extends UserDefn {
    hasGetMethod = false;
    hasSetMethod = false;

    constructor(file:string, line:number, name:string, props:Prop[], methods:Method[], origin:number) {
	super(file, line, name, DefnKind.Struct, props, methods, origin);
	for ( var m of methods ) {
	    if (m.kind == MethodKind.Get)
		this.hasGetMethod = true;
	    else if (m.kind == MethodKind.Set)
		this.hasSetMethod = true;
	}
    }
}

enum PropQual {
    None,
    Atomic,
    Synchronic
}

class Prop {
    typeRef: Defn = null;

    constructor(public line:number, public name:string, public qual:PropQual, public isArray:boolean, public typeName:string) {}
}

enum MethodKind {
    Virtual,
    Get,
    Set,
    Copy
}

class Method {
    constructor(public line:number, public kind:MethodKind, public name:string, public body: string[]) {}
}

class MapEntry {
    constructor(public name:string, public expand:boolean, public offset:number, public type:Defn) {}

    get memory(): string {
	if (this.type.kind != DefnKind.Primitive)
	    throw new Error("No memory type available for non-primitive type " + this.type.name);
	return (<PrimitiveDefn> this.type).memory;
    }

    get size(): number {
	return this.type.size;
    }

    toString() {
	return "(" + this.name + " " + this.expand + " " + this.offset + " " + this.type.name + ")";
    }
}

// TODO: push this into a struct, along with input/output file names

var allDefs:[UserDefn[],string[]][] = [];

function main(args: string[]) {
    for ( var input_file of args ) {
	if (input_file.length < 11 ||
	    (input_file.slice(-11) != ".js.parlang" && input_file.slice(-11) != ".ts.parlang"))
	    throw new Error("Bad file name (must be .js.parlang or .ts.parlang): " + input_file);
	var text = fs.readFileSync(input_file, "utf8");
	var lines = text.split("\n");
	allDefs.push(collectDefinitions(input_file, lines));
    }

    buildTypeMap();
    resolveTypeRefs();
    checkRecursion();
    layoutTypes();
    createVirtuals();
    expandSelfAccessors();
    pasteupTypes();
    expandGlobalAccessorsAndMacros();

    for ( var i=0 ; i < args.length ; i++ ) {
	var output_file = args[i].replace(/\.parlang$/,"");
	var text = allDefs[i][1].join("\n")
	fs.writeFileSync(output_file, text, "utf8");
    }
}

var Ws = "\\s+";
var Os = "\\s*";
var Id = "[A-Za-z][A-Za-z0-9]*"; // Note, no underscores are allowed
var Lbrace = Os + "\\{";
var Rbrace = Os + "\\}";
var Comment = Os + "(?:\\/\\/.*)?";

var start_re = new RegExp("^" + Os + "@shared" + Ws + "(?:struct|class)" + Ws + "(?:" + Id + ")");
var end_re = new RegExp("^" + Rbrace + Os + "@end" + Comment + "$");
var struct_re = new RegExp("^" + Os + "@shared" + Ws + "struct" + Ws + "(" + Id + ")" + Lbrace + Comment + "$");
var class_re = new RegExp("^" + Os + "@shared" + Ws + "class" + Ws + "(" + Id + ")" + Os + "(?:extends" + Ws + "(" + Id + "))?" + Lbrace + Comment + "$");
var special_re = new RegExp("^" + Os + "@(get|set|copy)" + Os + "(\\(" + Os + "self.*)$");
var method_re = new RegExp("^" + Os + "@method" + Ws + "(" + Id + ")" + Os + "(\\(" + Os + "self.*)$");
var blank_re = new RegExp("^" + Os + Comment + "$");
var space_re = new RegExp("^" + Os + "$");
var prop_re = new RegExp("^" + Os + "(" + Id + ")" + Os + ":" + Os + "(?:(atomic|synchronic)" + Ws + ")?(" + Id + ")" + Os + ";?" + Comment + "$");
var aprop_re = new RegExp("^" + Os + "(" + Id + ")" + Os + ":" + Os + "array" + Os + "\\(" + Os + "(" + Id + ")" + Os + "\\)" + Os + ";?" + Comment + "$");

function collectDefinitions(filename:string, lines:string[]):[UserDefn[], string[]] {
    var defs:UserDefn[] = [];
    var nlines:string[] = [];
    var i=0, lim=lines.length;
    while (i < lim) {
	var l = lines[i++];
	if (!start_re.test(l)) {
	    nlines.push(l);
	    continue;
	}

	var kind = "";
	var name = "";
	var inherit = "";
	var lineno = i;
	var m:string[] = null;
	if (m = struct_re.exec(l)) {
	    kind = "struct";
	    name = m[1];
	}
	else if (m = class_re.exec(l)) {
	    kind = "class";
	    name = m[1];
	    inherit = m[2] ? m[2] : "";
	}
	else
	    throw new Error(filename + ":" + i + ": Syntax error: Malformed definition line");

	var properties:Prop[] = [];
	var methods:Method[] = [];
	var in_method = false;
	var mbody = null;
	var method_type = MethodKind.Virtual;
	var method_name = "";

	// Do not check for duplicate names here since that needs to
	// take into account inheritance.

	while (i < lim) {
	    var l = lines[i++];
	    if (end_re.test(l))
		break;
	    if (m = method_re.exec(l)) {
		if (in_method)
		    methods.push(new Method(i, method_type, method_name, mbody));
		in_method = true;
		method_type = MethodKind.Virtual;
		method_name = m[1];
		mbody = [m[2]];
	    }
	    else if (m = special_re.exec(l)) {
		if (in_method)
		    methods.push(new Method(i, method_type, method_name, mbody));
		in_method = true;
		switch (m[1]) {
		case "get": method_type = MethodKind.Get; break;
		case "set": method_type = MethodKind.Set; break;
		case "copy": method_type = MethodKind.Copy; break;
		}
		method_name = "";
		mbody = [m[2]];
	    }
	    else if (m = prop_re.exec(l)) {
		var qual = PropQual.None;
		switch (m[2]) {
		case "synchronic": qual = PropQual.Synchronic; break;
		case "atomic": qual = PropQual.Atomic; break;
		}
		properties.push(new Prop(i, m[1], qual, false, m[3]));
	    }
	    else if (m = aprop_re.exec(l)) {
		properties.push(new Prop(i, m[1], PropQual.None, true, m[2]));
	    }
	    else if (in_method) {
		// TODO: if we're going to be collecting random cruft
		// then blank and comment lines at the end of a method
		// really should be placed at the beginning of the
		// next method.  Also see hack in pasteupTypes() that
		// removes blank lines from the end of a method body.
		mbody.push(l);
	    }
	    else if (blank_re.test(l)) {
	    }
	    else
		throw new Error(filename + ":" + i + ": Syntax error: Not a property or method: " + l);
	}
	if (in_method)
	    methods.push(new Method(i, method_type, method_name, mbody));

	if (kind == "class")
	    defs.push(new ClassDefn(filename, lineno, name, inherit, properties, methods, nlines.length));
	else
	    defs.push(new StructDefn(filename, lineno, name, properties, methods, nlines.length));
    }
    return [defs, nlines];
}

var builtinTypes =
    {int8:    new PrimitiveDefn("int8", 1, true),
     uint8:   new PrimitiveDefn("uint8", 1, true),
     int16:   new PrimitiveDefn("int16", 2, true),
     uint16:  new PrimitiveDefn("uint16", 2, true),
     int32:   new PrimitiveDefn("int32", 4, true),
     uint32:  new PrimitiveDefn("uint32", 4, true),
     float32: new PrimitiveDefn("float32", 4, false),
     float64: new PrimitiveDefn("float64", 8, false)
};

var atomicTypes = {int8:true, uint8:true, int16:true, uint16:true, int32:true, uint32:true};
var knownTypes = {};		// Map from string to UserDefn
var knownIds = {};
var allTypes:UserDefn[] = [];

function buildTypeMap() {
    for ( var i=0 ; i < allDefs.length ; i++ ) {
	var defs = allDefs[i][0];
	for ( var d of defs ) {
	    if (knownTypes.hasOwnProperty(d.name))
		throw new Error(d.file + ":" + d.line + ": Duplicate type name: " + d.name);
	    knownTypes[d.name] = d;
	    allTypes.push(d);
	}
    }
}

// Reference checking:
//  - For each class type, check inheritance, and add a property inheritRef that references the definition
//  - For each property, check that the referenced type exists, and add a property typeRef that references the definition
//  - For each property, check that atomic/synchronic is only used on appropriate types

function resolveTypeRefs():void {
    for ( var i=0 ; i < allTypes.length ; i++ ) {
	var d = allTypes[i];
	if (d.kind == DefnKind.Class) {
	    var cls = <ClassDefn> d;
	    if (cls.baseName != "") {
		if (!knownTypes.hasOwnProperty(cls.baseName))
		    throw new Error(cls.file + ":" + cls.line + ": Missing base type: " + cls.baseName);
		cls.baseTypeRef = knownTypes[cls.baseName];
		cls.baseTypeRef.subclasses.push(cls);
	    }
	}
	for ( var p of d.props ) {
	    if (p.qual != PropQual.None) {
		if (!atomicTypes.hasOwnProperty(p.typeName))
		    throw new Error(d.file + ":" + p.line + ": Not an atomic type: " + p.typeName);
	    }
	    if (builtinTypes.hasOwnProperty(p.typeName)) {
		p.typeRef = builtinTypes[p.typeName];
		continue;
	    }
	    if (!knownTypes.hasOwnProperty(p.typeName))
		throw new Error(d.file + ":" + p.line + ": Undefined type: " + p.typeName);
	    p.typeRef = knownTypes[p.typeName];
	}
    }
}

function checkRecursion():void {
    for ( var d of allTypes ) {
	if (d.kind == DefnKind.Struct)
	    checkRecursionForStruct(<StructDefn> d);
	else if (d.kind == DefnKind.Class)
	    checkRecursionForClass(<ClassDefn> d);
    }

    // For a struct type, check that it does not include itself.
    function checkRecursionForStruct(d:StructDefn):void {
	if (d.checked)
	    return;
	d.live = true;
	for ( var p of d.props ) {
	    if (p.isArray)
		continue;
	    if (builtinTypes.hasOwnProperty(p.typeName))
		continue;
	    var probe:UserDefn = knownTypes[p.typeName];
	    if (probe.kind != DefnKind.Struct)
		continue;
	    var s = <StructDefn> probe;
	    if (s.live)
		throw new Error("Recursive type reference to struct " + p.typeName + " from " + d.name); // TODO: file/line
	    p.typeRef = s;
	    checkRecursionForStruct(s);
	}
	d.live = false;
	d.checked = true;
    }

    // For a class type, check that it does not inherit from itself.
    function checkRecursionForClass(d:ClassDefn):void {
	if (d.checked)
	    return;
	d.live = true;
	if (d.baseTypeRef) {
	    if (d.baseTypeRef.live)
		throw new Error("Recursive type reference to base class from " + d.name); // TODO: file/line
	    checkRecursionForClass(d.baseTypeRef);
	}
	d.live = false;
	d.checked = true;
    }
}

function layoutTypes():void {
    for ( var d of allTypes ) {
	if (d.kind == DefnKind.Class)
	    layoutClass(<ClassDefn> d);
	else
	    layoutStruct(<StructDefn> d);
    }
}

function layoutClass(d:ClassDefn):void {
    var map = {};
    var size = 4;
    var align = 4;
    if (d.baseName != "") {
	if (d.baseTypeRef.map == null)
	    layoutClass(d.baseTypeRef);
	map = shallowCopy(d.baseTypeRef.map);
	size = d.baseTypeRef.size;
	align = d.baseTypeRef.align;
    }
    layoutDefn(d, map, size, align);
    // layoutDefn updates d.map, d.size, d.align
    d.className = (d.baseTypeRef ? (d.baseTypeRef.className + ">") : "") + d.name;
    d.classId = computeClassId(d.className);
    if (knownIds[d.classId])
	throw new Error("Duplicate class ID for " + d.className + ": previous=" + knownIds[d.classId] + ", id=" + d.classId);
    knownIds[d.classId] = d.className;
}

function layoutStruct(d:UserDefn):void {
    layoutDefn(d, {}, 0, 0);
}

function layoutDefn(d:UserDefn, map, size:number, align:number):void {
    for ( var p of d.props ) {
	var k = p.typeRef.kind;
	if (p.isArray)
	    k = DefnKind.Class;
	switch (k) {
	case DefnKind.Primitive: {
	    var pt = <PrimitiveDefn> p.typeRef;
	    size = (size + pt.size - 1)&~(pt.size - 1);
	    align = Math.max(align, pt.align);
	    map[p.name] = new MapEntry(p.name, true, size, pt);
	    size += pt.size;
	    break;
	}
	case DefnKind.Class: {
	    // Could also be array, don't look at the contents
	    size = (size + 3) & ~3;
	    align = Math.max(align, 4);
	    map[p.name] = new MapEntry(p.name, true, size, builtinTypes.int32);
	    size += 4;
	    break;
	}
	case DefnKind.Struct: {
	    var st = <StructDefn> p.typeRef;
	    if (st.map == null)
		layoutStruct(st);
	    size = (size + st.align - 1) & ~(st.align - 1);
	    align = Math.max(align, st.align);
	    map[p.name] = new MapEntry(p.name, false, size, st);
	    var root = p.name;
	    for ( var n in st.map ) {
		if (st.map.hasOwnProperty(n)) {
		    var fld = st.map[n];
		    var fldname = root + "_" + fld.name;
		    map[fldname] = new MapEntry(fldname, fld.expand, size + fld.offset, fld.type);
		}
	    }
	    size += st.size;
	    break;
	}
	}
    }
    // Struct size must be rounded up to alignment so that n*SIZE makes a valid array:
    // each array element must be suitably aligned.
    if (d.kind == DefnKind.Struct)
	size = (size + align - 1) & ~(align - 1);
    d.map = map;
    d.size = size;
    d.align = align;
}

function shallowCopy(obj) {
    var result = {};
    for ( var n in obj )
	if (obj.hasOwnProperty(n))
	    result[n] = obj[n];
    return result;
}

// Compute a 28-bit nonnegative hash value for the name.  This needs
// to be *globally* unique (ie across workers).  There's really no
// easy way to guarantee that, but we check uniqueness within each
// program and so long as a type used in both programs is unique
// within both programs we're mostly fine.  The risk is that type A in
// program P1 is misidentified as type B in program P2 because A and B
// have the same class ID and P1 does not include B and P2 does not
// include A.  But that's technically a bug in the programs.

function computeClassId(name:string):number {
    var n = name.length;
    for (var i=0 ; i < name.length ; i++ ) {
	var c = name.charAt(i);
	var v = 0;
	if (c >= 'A' && c <= 'Z')
	    v = c.charCodeAt(0) - 'A'.charCodeAt(0);
	else if (c >= 'a' && c <= 'z')
	    v = c.charCodeAt(0) - 'a'.charCodeAt(0) + 26;
	else if (c >= '0' && c <= '9')
	    v = c.charCodeAt(0) - '0'.charCodeAt(0) + 52;
	else if (c == '_')
	    v = 62;
	else if (c == '>')
	    v = 63;
	else
	    throw new Error("Internal error: Bad character in class name: " + c);
	n = (((n & 0x1FFFFFF) << 3) | (n >>> 25)) ^ v;
    }
    return n;
}

// For each class, create a representation of its vtable

function createVirtuals():void {
    for ( var t of allTypes )
	if (t.kind == DefnKind.Class)
	    createVirtualsFor(<ClassDefn> t);
}

/*
    for ( a given virtual name in me or my parent )
        for ( my subclass ids including me )
   	    create a case that tests that id:
                dispatch to the first impl in the chain starting at that subclass, if any, stopping at me
        create a default
            if the virtual is inherited by me then dispatch to the first impl in the chain starting at my parent
            otherwise throw
*/

function createVirtualsFor(cls: ClassDefn): void {
    var vtable = [];
    var mnames = new VirtualMethodNameIterator(cls);
    for ( var [mname, isInherited] = mnames.next() ; mname != "" ; [mname, isInherited] = mnames.next() ) {
	var reverseCases = {};
	var subs = new InclusiveSubclassIterator(cls);
	for ( var subcls = subs.next() ; subcls ; subcls = subs.next() ) {
	    var impl = findMethodImplFor(subcls, cls.baseTypeRef, mname);
	    if (!impl)
		continue;
	    if (!reverseCases.hasOwnProperty(impl))
		reverseCases[impl] = [];
	    reverseCases[impl].push(subcls.classId);
	}
	var def = null;
	if (isInherited && cls.baseTypeRef)
	    def = findMethodImplFor(cls.baseTypeRef, null, mname);
	vtable.push({ name: mname, reverseCases: reverseCases, default_: def });
    }
    cls.vtable = vtable;
}

function findMethodImplFor(cls, stopAt, name) {
    if (cls == stopAt)
	return null;
    if (cls.hasMethod(name))
	return cls.name + "." + name + "_impl";
    if (cls.baseTypeRef)
	return findMethodImplFor(cls.baseTypeRef, stopAt, name);
    throw new Error("Internal error: Method not found: " + name);
}


// TODO: This will also match bogus things like XSELF_ because there's
// no lookbehind.

var self_getter_re = /SELF_(?:ref_|notify_)?[a-zA-Z0-9_]+/g;
var self_accessor_re = /SELF_(?:set_|add_|sub_|or_|compareExchange_|loadWhenEqual_|loadWhenNotEqual_|expectUpdate_)[a-zA-Z0-9_]+\s*\(/g;

// TODO: really should check validity of the name here, not hard to do.
// Can fall back on that happening on the next pass probably.

function expandSelfAccessors():void {
    for ( var t of allTypes ) {
	for ( var m of t.methods ) {
	    var body = m.body;
	    for ( var k=0 ; k < body.length ; k++ ) {
		body[k] = body[k].replace(self_accessor_re, function (m, p, s) {
		    return t.name + "." + m.substring(5) + "self, ";
		});
		body[k] = body[k].replace(self_getter_re, function (m, p, s) {
		    return t.name + "." + m.substring(5) + "(self)";
		});
	    }
	}
    }
}

function pasteupTypes():void {
    for ( var i=0 ; i < allDefs.length ; i++ ) {
	var defs = allDefs[i][0];
	var lines = allDefs[i][1];
	var nlines = [];
	var k = 0;
	for ( var j=0 ; j < defs.length ; j++ ) {
	    var d:UserDefn = defs[j];
	    while (k < d.origin && k < lines.length)
		nlines.push(lines[k++]);
	    nlines.push("const " + d.name + " = {");
	    nlines.push("  NAME: \"" + d.name + "\",");
	    nlines.push("  SIZE: " + d.size + ",");
	    nlines.push("  ALIGN: " + d.align + ",");
	    if (d.kind == DefnKind.Class) {
		var cls = <ClassDefn> d;
		nlines.push("  CLSID: " + cls.classId + ",");
	    }

	    // Now do methods.
	    //
	    // Implementation methods are emitted directly in the defining type, with a name suffix _impl.
	    // For struct methods, the name is "_get_impl", "_set_impl", or "_copy_impl".

	    var meths = d.methods;
	    for ( var l=0 ; l < meths.length ; l++ ) {
		var m = meths[l];
		var name = m.name;
		if (name == "") {
		    switch (m.kind) {
		    case MethodKind.Get: name = "_get_impl"; break;
		    case MethodKind.Set: name = "_set_impl"; break;
		    case MethodKind.Copy: name = "_copy_impl"; break;
		    }
		}
		else if (name == "init")
		    ;
		else
		    name += "_impl";
		var body = m.body;
		// Formatting: useful to strip all trailing blank lines from
		// the body first.
		var last = body.length-1;
		while (last > 0 && /^\s*$/.test(body[last]))
		    last--;
		if (last == 0)
		    nlines.push("  " + name + " : function " + body[0] + ",");
		else {
		    nlines.push("  " + name + " : function " + body[0]);
		    for ( var x=1; x < last ; x++ )
			nlines.push(body[x]);
		    nlines.push(body[last] + ",");
		}
	    }

	    // Now do vtable, if appropriate.

	    // TODO: instead of using ...args we really must use a
	    // signature from one of the method defs, but it's tricky
	    // since we may have to strip annotations, and there's
	    // also a question about rest arguments.  (Not to mention
	    // the arguments object.)

	    // TODO: better error message?

	    if (d.kind == DefnKind.Class) {
		var cls = <ClassDefn> d;
		var vtable = cls.vtable;
		for ( var l=0 ; l < vtable.length ; l++ ) {
		    var virtual = vtable[l];
		    nlines.push(virtual.name + ": function (self, ...args) {");
		    nlines.push("  switch (_mem_int32[self>>2]) {");
		    var rev = virtual.reverseCases;
		    for ( var revname in rev ) {
			if (rev.hasOwnProperty(revname)) {
			    var revs = rev[revname];
			    for ( var r=0 ; r < revs.length ; r++ )
				nlines.push("    case " + revs[r] + ": ");
			    nlines.push("      return " + revname + "(self, ...args);");
			}
		    }
		    nlines.push("    default:");
		    nlines.push("      " + (virtual.default_ ? ("return " + virtual.default_ + "(self, ...args)") : "throw new Error('Bad type')") + ";");
		    nlines.push("  }");
		    nlines.push("},");
		}
	    }

	    // Now do other methods: initInstance.

	    if (d.kind == DefnKind.Class) {
		var cls = <ClassDefn> d;
		nlines.push("initInstance:function(self) { _mem_int32[self>>2]=" + cls.classId + "; return self; },");
	    }

	    nlines.push("}");
	    if (d.kind == DefnKind.Class)
		nlines.push("Parlang._idToType[" + (<ClassDefn> d).classId + "] = " + d.name + ";");
	}
	while (k < lines.length)
	    nlines.push(lines[k++]);
	allDefs[i][1] = nlines;
    }
}

var acc_re = null;
var arr_re = null;
var new_re = null;

function setupRegexes() {
    /*
    var ts = "int8|uint8|int16|uint16|int32|uint32|float32|float64";
    var cs = "";
    var us = "";
    for ( var i=0 ; i < allTypes.length ; i++ ) {
	ts += "|";
	ts += allTypes[i].name;
	if (allTypes[i].kind == DefnKind.Class) {
	    if (cs != "")
		cs += "|";
	    cs += allTypes[i].name;
	}
	if (allTypes[i].kind == DefnKind.Struct) {
	    if (us != "")
		us += "|";
	    us += allTypes[i].name;
	}
    }
    var xs = "";
    if (cs && us)
	xs = cs + "|" + us;
    else if (cs)
	xs = cs;
    else
	xs = us;
	*/

    acc_re = new RegExp("([A-Za-z][A-Za-z0-9]*)\\.(set_|ref_)?([a-zA-Z0-9_]+)\\s*\\(", "g");
    arr_re = new RegExp("([A-Za-z][A-Za-z0-9]*)\\.array_(get|set)(?:_([a-zA-Z0-9_]+))?\\s*\\(", "g");
    new_re = new RegExp("@new\\s+(?:array\\s*\\(\\s*([A-Za-z][A-Za-z0-9]*)\\s*,|([A-Za-z][A-Za-z0-9]*))", "g");
}

function expandGlobalAccessorsAndMacros():void {
    setupRegexes();

    for ( var i=0 ; i < allDefs.length ; i++ ) {
	var lines = allDefs[i][1];
	var nlines = [];
	for ( var j=0 ; j < lines.length ; j++ )
	    nlines.push(expandMacrosIn(lines[j]))
	allDefs[i][1] = nlines;
    }
}

function expandMacrosIn(text) {
    return myExec(new_re, newMacro, myExec(arr_re, arrMacro, myExec(acc_re, accMacro, text)));
}

function myExec(re, macro, text) {
    var old = re.lastIndex;
    re.lastIndex = 0;

    var m;
    while (m = re.exec(text)) {
	// The trick here is that we may replace more than the match:
	// the macro may eat additional input.  So the macro should
	// be returning a new string, as well as the index at which
	// to continue the search.
	var [newText, newStart] = macro(text, re.lastIndex-m[0].length, m);
	text = newText;
	re.lastIndex = newStart;
    }

    re.lastIndex = old;
    return text;
}

class ParamParser {
    private lim = 0;
    private done = false;

    constructor(private input:string, private pos:number) {
	this.lim = input.length;
    }

    // Returns null on failure to find a next argument
    private nextArg():string {
	if (this.done)
	    return null;
	var depth = 0;
	var start = this.pos;
	// TODO: Really should outlaw regular expressions, but much harder, and somewhat marginal
	// TODO: Really should handle /* .. */ comments
	// TODO: Check that parens and braces nest properly
	while (this.pos < this.lim) {
	    switch (this.input.charAt(this.pos++)) {
	    case ',':
		if (depth == 0)
		    return cleanupArg(this.input.substring(start, this.pos-1));
		break;
	    case '(':
	    case '{':
	    case '[':
		depth++;
		break;
	    case '}':
	    case ']':
		depth--;
		break;
	    case ')':
		if (depth == 0) {
		    this.done = true;
		    return cleanupArg(this.input.substring(start, this.pos-1));
		}
		depth--;
		break;
	    case '\'':
	    case '"':
		// FIXME: implement this
		throw new Error("Internal error: Avoid strings in arguments for now");
	    }
	}
    }

    allArgs():string[] {
	var as:string[] = [];
	var a;
	while (a = this.nextArg())
	    as.push(a);
	return as;
    }

    get where(): number {
	return this.pos;
    }
}

function cleanupArg(s:string):string {
    s = s.replace(/^\s*|\s*$/g, "");
    if (s == "")
	return null;
    return s;
}

function accMacro(s, p, ms) {
    var m = ms[0];
    var className = ms[1];
    var operation = ms[2];
    var propName = ms[3];

    var nomatch = [s, p+m.length];
    var left = s.substring(0,p);

    // FIXME: atomics, synchronics and all operations on them
    // Atomics should be expanded inline.
    // Synchronics should indirect through methods on Parlang, probably.

    if (!operation)
	operation = "get_";
    var cls = knownTypes[className];
    if (!cls)
	return nomatch;
    var fld = cls.findAccessibleFieldFor(operation, propName);
    if (!fld)
	return nomatch;

    // TODO: Emit warnings for arity abuse, at a minimum.

    var pp = new ParamParser(s, p+m.length);
    var as = (pp).allArgs();
    switch (operation) {
    case "get_": if (as.length != 1) { console.log("Bad get arity " + propName + " " + as.length); return nomatch; }; break;
    case "set_": if (as.length != 2) { console.log("Bad set arity " + propName + " " + as.length); return nomatch; }; break;
    }

    var ref = "(" + expandMacrosIn(endstrip(as[0])) + "+" + fld.offset + ")";
    if (operation == "ref_") {
	return [left + ref + s.substring(pp.where),
		left.length + ref.length];
    }

    return loadFromRef(ref, fld.type, s, left, operation, pp, as[1], nomatch);
}

function loadFromRef(ref, type, s, left, operation, pp, rhs, nomatch) {
    var mem="", size=0;
    if (type.kind == DefnKind.Primitive) {
	mem = (<PrimitiveDefn> type).memory;
	size = type.size;
    }
    else if (type.kind == DefnKind.Class) {
	mem = "_mem_int32";
	size = 4;
    }
    if (size > 0) {
	switch (operation) {
	case "get_": {
	    var expr = "(" + mem + "[" + ref + ">>" + log2(size) + "])";
	    return [left + expr + s.substring(pp.where),
		    left.length + expr.length];
	}
	case "set_": {
	    var expr = "(" + mem + "[" + ref + ">>" + log2(size) + "] = " + expandMacrosIn(endstrip(rhs)) + ")";
	    return [left + expr + s.substring(pp.where),
		    left.length + expr.length];
	}
	default:
	    return nomatch;		// Warning desired
	}
    }
    else {
	var t = <StructDefn> type;

	// Field type is a structure.  If the structure type has a getter then getting is allowed
	// and should be rewritten as a call to the getter, passing the field reference.
	// Ditto setter, which will also pass secondArg.
	switch (operation) {
	case "get_": {
	    if (!t.hasGetMethod)
		return nomatch;	// Warning desired
	    var expr = "(" + t.name + "._get_impl(" + ref + "))";
	    return [left + expr + s.substring(pp.where),
		    left.length + expr.length];
	}
	case "set_": {
	    if (!t.hasSetMethod)
		return nomatch;	// Warning desired
	    var expr = "(" + t.name + "._set_impl(" + ref + "," + expandMacrosIn(endstrip(rhs)) + "))";
	    return [left + expr + s.substring(pp.where),
		    left.length + expr.length];
	}
	default:
	    return nomatch;	// Warning desired
	}
    }
}

// operation is get or set
// typename is the base type, which could be any type at all
// field may be blank, but if it is not then it is the field name within the
//   type, eg, for a struct Foo with field x we may see Foo.array_get_x(self, n)
// firstArg and secondArg are non-optional; thirdArg is used if the operation is set

function arrMacro(s, p, ms) {
    var m=ms[0];
    var typeName=ms[1];
    var operation=ms[2];
    var field=ms[3];
    var nomatch = [s,p+m.length];

    var type = findType(typeName);
    if (!type)
	return nomatch;

    var pp = new ParamParser(s, p+m.length);
    var as = (pp).allArgs();

    // TODO: Emit warnings for arity abuse, at a minimum.  This is clearly very desirable.

    switch (operation) {
    case "get": if (as.length != 2) return nomatch; operation = "get_"; break;
    case "set": if (as.length != 3) return nomatch; operation = "set_"; break;
    }

    if (type.kind == DefnKind.Primitive) {
	if (field)
	    return nomatch;
    }
    else if (type.kind == DefnKind.Class) {
	if (field)
	    return nomatch;
    }
    var ref = "(" + expandMacrosIn(endstrip(as[0])) + "+" + type.size + "*" + expandMacrosIn(endstrip(as[1])) + ")";
    if (field) {
	var fld = type.findAccessibleFieldFor(operation, field);
	if (!fld)
	    return nomatch;
	ref = "(" + ref + "+" + fld.offset + ")";
	type = fld.type;
    }

    return loadFromRef(ref, type, s, s.substring(0,p), operation, pp, as[2], nomatch);
}

// Since @new is new syntax, we throw errors for all misuse.

function newMacro(s, p, ms) {
    var m=ms[0];
    var arrayType=ms[1];
    var classType=ms[2];
    var left = s.substring(0,p);
    if (classType !== undefined) {
	var t = knownTypes[classType];
	if (!t)
	    throw new Error("Unknown type argument to @new: " + classType);
	var expr = "(" + classType + ".initInstance(Parlang.alloc(" + t.size + "," + t.align + ")))";
	return [left + expr + s.substring(p + m.length),
		left.length + expr.length ];
    }

    var pp = new ParamParser(s, p+m.length);
    var as = pp.allArgs();
    if (as.length != 1)
	throw new Error("Wrong number of arguments to @new array(" + arrayType + ")")

    var t = findType(arrayType);
    if (!t)
	throw new Error("Unknown type argument to @new array: " + arrayType);
    var expr = "(Parlang.alloc(" + t.size + " * " + expandMacrosIn(endstrip(as[0])) + ", " + t.align + "))";
    return [left + expr + s.substring(pp.where),
	    left.length + expr.length];
}

function findType(name:string) {
    if (builtinTypes.hasOwnProperty(name))
	return builtinTypes[name];
    if (knownTypes.hasOwnProperty(name))
	return knownTypes[name];
    throw new Error("Internal: Unknown type in sizeofType: " + name);
}

// This can also check if x is already properly parenthesized, though that
// involves counting parens, at least trivially (and then does it matter?).
// Consider (a).(b), which should be parenthesized as ((a).(b)).

function endstrip(x:string):string {
    if (/^[a-zA-Z0-9]+$/.test(x))
	return x;
    return "(" + x + ")";
}

function log2(x:number):number {
    if (i <= 0)
	throw new Error("log2: " + x);
    var i = 0;
    while (x > 1) {
	i++;
	x >>= 1;
    }
    return i;
}

main(process.argv.slice(2));