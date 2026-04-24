"use strict";

import * as acorn from "https://unpkg.com/acorn@8/dist/acorn.mjs";

const dom = {
  runButton: document.querySelector(".run"),
  code: document.getElementById("code"),
  codeEditor: document.getElementById("code-editor"),
  codeHighlight: document.getElementById("code-highlight"),
  codeLineNumbers: document.getElementById("code-line-numbers"),
  output: document.getElementById("output"),
  outputLineNumbers: document.getElementById("output-line-numbers"),
  variables: document.getElementById("variables"),
  scopeChain: document.getElementById("scope-chain"),
  executionContexts: document.getElementById("execution-contexts"),
  memoryGrid: document.getElementById("memory-grid"),
  bindingLayer: document.getElementById("binding-layer"),
  callStack: document.getElementById("call-stack"),
  heapMap: document.getElementById("heap-map"),
};

let pendingBindingRender = 0;
let pendingBindingRefresh = 0;
let pendingEditorSync = 0;
let lastEditorValue = null;
let lastEditorLineCount = 0;
let lastEditorHeight = 0;
let editorLineMetrics = null;
const lineNumberCache = new Map();
const PASSIVE_EVENT = { passive: true };

const HTML_ESCAPE = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPE[char]);
}

function escapeCssIdentifier(value) {
  const text = String(value ?? "");

  if (window.CSS?.escape) {
    return window.CSS.escape(text);
  }

  return text.replace(/["\\]/g, "\\$&");
}

const JS_KEYWORDS = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "of",
  "return",
  "set",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const JS_LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);
const JS_BUILT_INS = new Set([
  "Array",
  "Boolean",
  "Date",
  "Error",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Promise",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "console",
  "document",
  "window",
]);

const JS_TOKEN_REGEX =
  /\/\*[\s\S]*?\*\/|\/\/.*|`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b[$A-Z_a-z][$\w]*\b|=>|===|!==|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|\*\*|[{}()[\].,;:+\-*/%=&|!<>?~]/g;

function highlightJavaScript(source) {
  return highlightWithRegex(source, JS_TOKEN_REGEX, (token) => {
    if (token.startsWith("//") || token.startsWith("/*")) {
      return "token-comment";
    }

    if (/^['"`]/.test(token)) {
      return "token-string";
    }

    if (/^\d/.test(token)) {
      return "token-number";
    }

    if (JS_KEYWORDS.has(token)) {
      return "token-keyword";
    }

    if (JS_LITERALS.has(token)) {
      return "token-literal";
    }

    if (JS_BUILT_INS.has(token)) {
      return "token-builtin";
    }

    if (/^[{}()[\].,;:]$/.test(token)) {
      return "token-punctuation";
    }

    if (/^(=>|===|!==|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|\*\*|[+\-*/%=&|!<>?~])$/.test(token)) {
      return "token-operator";
    }

    return "token-identifier";
  });
}

function highlightJson(source) {
  return highlightWithRegex(
    source,
    /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\btrue\b|\bfalse\b|\bnull\b|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|[{}[\],:]/gi,
    (token, match) => {
      if (token.startsWith('"') && token.endsWith('"')) {
        const afterToken = source.slice(match.index + token.length);
        return /^\s*:/.test(afterToken) ? "token-property" : "token-string";
      }

      if (/^-?\d/.test(token)) {
        return "token-number";
      }

      if (/^(true|false|null)$/i.test(token)) {
        return "token-literal";
      }

      return "token-punctuation";
    }
  );
}

function highlightWithRegex(source, regex, getClassName) {
  let html = "";
  let lastIndex = 0;

  for (const match of source.matchAll(regex)) {
    const token = match[0];
    const index = match.index;

    html += escapeHtml(source.slice(lastIndex, index));
    html += `<span class="${getClassName(token, match, source)}">${escapeHtml(token)}</span>`;
    lastIndex = index + token.length;
  }

  html += escapeHtml(source.slice(lastIndex));
  return html;
}

function renderLineNumbers(count) {
  const safeCount = Math.max(1, count);

  if (!lineNumberCache.has(safeCount)) {
    lineNumberCache.set(
      safeCount,
      Array.from({ length: safeCount }, (_, index) => index + 1).join("<br>")
    );
  }

  return lineNumberCache.get(safeCount);
}

function countLines(text) {
  return Math.max(1, String(text ?? "").split("\n").length);
}

function parseCode(code) {
  const parserOptions = {
    ecmaVersion: "latest",
    locations: true,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  };

  try {
    return acorn.parse(code, { ...parserOptions, sourceType: "script" });
  } catch (scriptError) {
    try {
      return acorn.parse(code, { ...parserOptions, sourceType: "module" });
    } catch {
      throw scriptError;
    }
  }
}

function runCode() {
  clearViews();

  const code = dom.code.value.trim();
  if (!code) {
    renderEmptyState("Paste JavaScript code and press Run to build the visual model.");
    return;
  }

  try {
    const ast = parseCode(code);
    const model = analyzeProgram(ast, code);

    renderJsonOutput(ast);
    renderVariableEnvironment(model);
    renderScopeChain(model);
    renderExecutionContexts(model);
    renderCallStack(model);
    renderHeap(model);
  } catch (error) {
    const message = `${error.name || "ParseError"}: ${error.message}`;
    renderOutputError(message);
    dom.variables.textContent = message;
    renderEmptyState("The parser could not build visualizations for this code.");
  }
}

function clearViews() {
  dom.output.innerHTML = "";
  syncOutputLineNumbers("");
  dom.variables.textContent = "";
  dom.scopeChain.innerHTML = "";
  dom.executionContexts.innerHTML = "";
  dom.callStack.innerHTML = "";
  dom.heapMap.innerHTML = "";
  dom.bindingLayer.innerHTML = "";
}

function renderJsonOutput(value) {
  const json = JSON.stringify(value, null, 2);
  dom.output.innerHTML = highlightJson(json);
  syncOutputLineNumbers(json);
}

function renderOutputError(message) {
  dom.output.innerHTML = `<span class="token-error">${escapeHtml(message)}</span>`;
  syncOutputLineNumbers(message);
}

function syncCodeEditor() {
  pendingEditorSync = 0;
  normalizeCodeTail();

  const code = dom.code.value;
  const lineCount = countLines(code);

  if (code !== lastEditorValue) {
    dom.codeHighlight.innerHTML = code ? `${highlightJavaScript(code)}\n` : "";
    lastEditorValue = code;
  }

  if (lineCount !== lastEditorLineCount) {
    dom.codeLineNumbers.innerHTML = renderLineNumbers(lineCount);
    lastEditorLineCount = lineCount;
  }

  resizeCodeEditor(lineCount);
  syncEditorScroll();
}

function scheduleCodeEditorSync() {
  window.cancelAnimationFrame(pendingEditorSync);
  pendingEditorSync = window.requestAnimationFrame(syncCodeEditor);
}

function normalizeCodeTail() {
  const normalized = dom.code.value.replace(/(?:\n[ \t]*){2,}$/g, "\n");

  if (normalized === dom.code.value) {
    return;
  }

  const removedChars = dom.code.value.length - normalized.length;
  const selectionStart = Math.max(0, dom.code.selectionStart - removedChars);
  const selectionEnd = Math.max(0, dom.code.selectionEnd - removedChars);

  dom.code.value = normalized;
  dom.code.selectionStart = selectionStart;
  dom.code.selectionEnd = selectionEnd;
}

function resizeCodeEditor(lineCount) {
  if (!editorLineMetrics) {
    const style = window.getComputedStyle(dom.code);
    editorLineMetrics = {
      lineHeight: parseFloat(style.lineHeight) || 25,
      paddingTop: parseFloat(style.paddingTop) || 0,
      paddingBottom: parseFloat(style.paddingBottom) || 0,
    };
  }

  const height = Math.min(
    430,
    Math.max(
      185,
      Math.ceil(
        lineCount * editorLineMetrics.lineHeight +
          editorLineMetrics.paddingTop +
          editorLineMetrics.paddingBottom
      )
    )
  );

  if (height !== lastEditorHeight) {
    dom.codeEditor.style.setProperty("--code-editor-height", `${height}px`);
    lastEditorHeight = height;
  }
}

function syncEditorScroll() {
  const highlightLayer = dom.codeHighlight.parentElement;

  highlightLayer.scrollTop = dom.code.scrollTop;
  highlightLayer.scrollLeft = dom.code.scrollLeft;
  dom.codeLineNumbers.scrollTop = dom.code.scrollTop;
}

function syncOutputLineNumbers(text = dom.output.textContent) {
  const lineCount = countLines(text);

  dom.outputLineNumbers.innerHTML = renderLineNumbers(lineCount);
  syncOutputScroll();
}

function syncOutputScroll() {
  dom.outputLineNumbers.scrollTop = dom.output.scrollTop;
}

function handleEditorKeydown(event) {
  if (event.key !== "Tab") {
    return;
  }

  event.preventDefault();

  const start = dom.code.selectionStart;
  const end = dom.code.selectionEnd;
  const value = dom.code.value;

  dom.code.value = `${value.slice(0, start)}  ${value.slice(end)}`;
  dom.code.selectionStart = dom.code.selectionEnd = start + 2;
  syncCodeEditor();
}

function renderEmptyState(message) {
  const state = `<div class="empty-state">${escapeHtml(message)}</div>`;
  dom.scopeChain.innerHTML = state;
  dom.executionContexts.innerHTML = state;
  dom.callStack.innerHTML = state;
  dom.heapMap.innerHTML = state;
  dom.bindingLayer.innerHTML = "";
}

function analyzeProgram(ast, code) {
  let scopeId = 0;
  let contextId = 0;
  let heapId = 0;
  let frameId = 0;

  const model = {
    ast,
    code,
    scopes: [],
    scopesById: new Map(),
    contexts: [],
    contextsById: new Map(),
    contextsByScopeId: new Map(),
    contextsByCallableName: new Map(),
    callStack: [],
    heap: [],
    calls: [],
    scopeChainsById: new Map(),
    memory: null,
  };

  function createScope(name, type, parent = null, node = null) {
    const scope = {
      id: `S${++scopeId}`,
      name,
      type,
      parentId: parent?.id ?? null,
      depth: parent ? parent.depth + 1 : 0,
      declarations: [],
      children: [],
      line: node?.loc?.start?.line ?? null,
    };

    model.scopes.push(scope);
    model.scopesById.set(scope.id, scope);
    if (parent) {
      parent.children.push(scope.id);
    }

    return scope;
  }

  function createContext(name, type, scope, reason) {
    const context = {
      id: `EC${++contextId}`,
      name,
      type,
      scopeId: scope.id,
      scopeName: scope.name,
      depth: scope.depth,
      outer: scope.parentId ? findScope(scope.parentId)?.name : "none",
      reason,
    };

    model.contexts.push(context);
    model.contextsById.set(context.id, context);
    model.contextsByScopeId.set(scope.id, context);
    registerContextAliases(context);
    return context;
  }

  function createFrame(label, type, scope, line = null, context = null) {
    const activeContext = context || findNearestContextForScope(scope);

    return {
      frameId: `F${++frameId}`,
      label,
      type,
      scopeName: scope?.name || "External runtime",
      line,
      contextId: activeContext?.id || null,
      contextName: activeContext?.name || "External execution context",
    };
  }

  function addDeclaration(scope, name, kind, value, node = null) {
    if (!name) {
      return;
    }

    scope.declarations.push({
      name,
      kind,
      value: value || "uninitialized",
      line: node?.loc?.start?.line ?? null,
    });
  }

  function addHeap(label, type, details, scope, node = null) {
    const context = findNearestContextForScope(scope);
    const allocation = {
      id: `H${++heapId}`,
      label,
      type,
      details,
      scopeId: scope.id,
      scopeName: scope.name,
      contextId: context?.id || null,
      contextName: context?.name || "Unbound execution context",
      line: node?.loc?.start?.line ?? null,
    };

    model.heap.push(allocation);
    return allocation.id;
  }

  function findScope(id) {
    return model.scopesById.get(id);
  }

  function findNearestContextForScope(scope) {
    let currentScope = scope;

    while (currentScope) {
      const context = model.contextsByScopeId.get(currentScope.id);

      if (context) {
        return context;
      }

      currentScope = currentScope.parentId ? findScope(currentScope.parentId) : null;
    }

    return model.contexts[0] || null;
  }

  function findContextForCall(label) {
    const cleanLabel = String(label || "")
      .replace(/^new\s+/, "")
      .replace(/\(\)$/g, "");
    const labelParts = cleanLabel.split(".");
    const candidates = [cleanLabel, labelParts[labelParts.length - 1]].filter(Boolean);

    return candidates.map((candidate) => model.contextsByCallableName.get(candidate)).find(Boolean);
  }

  function registerContextAliases(context) {
    const callableName = context.name.replace(/\(\) Execution Context$/, "");
    const parts = callableName.split(".");
    const aliases = [callableName, parts[parts.length - 1]].filter(Boolean);

    aliases.forEach((alias) => {
      if (!model.contextsByCallableName.has(alias)) {
        model.contextsByCallableName.set(alias, context);
      }
    });
  }

  function getLineLabel(node) {
    return node?.loc?.start?.line ? `line ${node.loc.start.line}` : "unknown line";
  }

  function createBlockScope(label, parent, node) {
    return createScope(`${label} (${getLineLabel(node)})`, "block", parent, node);
  }

  const globalScope = createScope("Global scope", "global", null, ast);
  const globalContext = createContext(
    "Global Execution Context",
    "global",
    globalScope,
    "Created before the top-level code starts running."
  );
  model.callStack.push(createFrame("Global Execution Context", "global", globalScope, 1, globalContext));

  walkStatements(ast.body, globalScope, globalScope);

  finalizeModel(model);
  return model;

  function walkStatements(statements, currentScope, functionScope) {
    statements.forEach((statement) => walkStatement(statement, currentScope, functionScope));
  }

  function walkStatement(node, currentScope, functionScope) {
    if (!node) {
      return;
    }

    switch (node.type) {
      case "VariableDeclaration":
        handleVariableDeclaration(node, currentScope, functionScope);
        break;

      case "FunctionDeclaration":
        handleFunctionDeclaration(node, currentScope);
        break;

      case "ClassDeclaration":
        handleClassDeclaration(node, currentScope);
        break;

      case "ExpressionStatement":
        walkExpression(node.expression, currentScope, functionScope);
        break;

      case "ReturnStatement":
      case "ThrowStatement":
        walkExpression(node.argument, currentScope, functionScope);
        break;

      case "BlockStatement": {
        const blockScope = createBlockScope("Block scope", currentScope, node);
        walkStatements(node.body, blockScope, functionScope);
        break;
      }

      case "IfStatement":
        walkExpression(node.test, currentScope, functionScope);
        walkStatement(node.consequent, createBlockScope("If scope", currentScope, node.consequent), functionScope);
        if (node.alternate) {
          walkStatement(node.alternate, createBlockScope("Else scope", currentScope, node.alternate), functionScope);
        }
        break;

      case "ForStatement": {
        const forScope = createBlockScope("For scope", currentScope, node);
        if (node.init?.type === "VariableDeclaration") {
          handleVariableDeclaration(node.init, forScope, functionScope);
        } else {
          walkExpression(node.init, forScope, functionScope);
        }
        walkExpression(node.test, forScope, functionScope);
        walkExpression(node.update, forScope, functionScope);
        walkStatement(node.body, forScope, functionScope);
        break;
      }

      case "ForInStatement":
      case "ForOfStatement": {
        const loopScope = createBlockScope(node.type === "ForOfStatement" ? "For-of scope" : "For-in scope", currentScope, node);
        if (node.left?.type === "VariableDeclaration") {
          handleVariableDeclaration(node.left, loopScope, functionScope);
        } else {
          walkExpression(node.left, loopScope, functionScope);
        }
        walkExpression(node.right, loopScope, functionScope);
        walkStatement(node.body, loopScope, functionScope);
        break;
      }

      case "WhileStatement":
      case "DoWhileStatement": {
        const loopScope = createBlockScope(node.type === "WhileStatement" ? "While scope" : "Do-while scope", currentScope, node);
        walkExpression(node.test, loopScope, functionScope);
        walkStatement(node.body, loopScope, functionScope);
        break;
      }

      case "SwitchStatement": {
        const switchScope = createBlockScope("Switch scope", currentScope, node);
        walkExpression(node.discriminant, switchScope, functionScope);
        node.cases.forEach((switchCase) => {
          walkExpression(switchCase.test, switchScope, functionScope);
          walkStatements(switchCase.consequent, switchScope, functionScope);
        });
        break;
      }

      case "TryStatement":
        walkStatement(node.block, currentScope, functionScope);
        if (node.handler) {
          const catchScope = createBlockScope("Catch scope", currentScope, node.handler);
          extractPatternNames(node.handler.param).forEach((name) => {
            addDeclaration(catchScope, name, "catch", "caught error", node.handler.param);
          });
          walkStatement(node.handler.body, catchScope, functionScope);
        }
        walkStatement(node.finalizer, currentScope, functionScope);
        break;

      case "ImportDeclaration":
        node.specifiers.forEach((specifier) => {
          addDeclaration(currentScope, specifier.local.name, "import", "module binding", specifier);
        });
        break;

      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
        walkStatement(node.declaration, currentScope, functionScope);
        break;

      default:
        walkGenericNode(node, currentScope, functionScope);
    }
  }

  function handleVariableDeclaration(node, currentScope, functionScope) {
    const targetScope = node.kind === "var" ? functionScope : currentScope;

    node.declarations.forEach((declarator) => {
      const names = extractPatternNames(declarator.id);
      const hintName = names[0] || "anonymous";
      let value = describeExpression(declarator.init);

      if (declarator.init && isHeapExpression(declarator.init)) {
        const heapRef = recordHeapExpression(declarator.init, targetScope, hintName);
        value = `ref ${heapRef}`;
      } else {
        walkExpression(declarator.init, currentScope, functionScope);
      }

      names.forEach((name) => addDeclaration(targetScope, name, node.kind, value, declarator));
    });
  }

  function handleFunctionDeclaration(node, currentScope) {
    const name = node.id?.name || "anonymous";
    const heapRef = addHeap(
      `${name}()`,
      "function",
      `params: ${formatParams(node.params)}; body statements: ${node.body?.body?.length ?? 0}`,
      currentScope,
      node
    );

    addDeclaration(currentScope, name, "function", `ref ${heapRef}`, node);
    createFunctionScope(node, currentScope, name, "FunctionDeclaration");
  }

  function handleFunctionExpression(node, currentScope, hintName) {
    const name = node.id?.name || hintName || "anonymous";
    const heapRef = addHeap(
      `${name}()`,
      node.type === "ArrowFunctionExpression" ? "arrow function" : "function",
      `params: ${formatParams(node.params)}; ${node.async ? "async; " : ""}${node.generator ? "generator; " : ""}body: ${node.expression ? "expression" : "block"}`,
      currentScope,
      node
    );

    createFunctionScope(node, currentScope, name, node.type);
    return heapRef;
  }

  function handleClassDeclaration(node, currentScope) {
    const name = node.id?.name || "AnonymousClass";
    const heapRef = addHeap(
      name,
      "class",
      `methods: ${node.body?.body?.length ?? 0}${node.superClass ? "; extends " + describeExpression(node.superClass) : ""}`,
      currentScope,
      node
    );

    addDeclaration(currentScope, name, "class", `ref ${heapRef}`, node);
    walkClassBody(node, currentScope, name);
  }

  function createFunctionScope(node, parentScope, name, kind) {
    const functionScope = createScope(`Function ${name}()`, "function", parentScope, node);

    if (node.id?.name && kind !== "FunctionDeclaration") {
      addDeclaration(functionScope, node.id.name, "function-name", "self reference", node.id);
    }

    node.params?.forEach((param) => {
      extractPatternNames(param).forEach((paramName) => {
        addDeclaration(functionScope, paramName, "param", "argument value", param);
      });
    });

    createContext(
      `${name}() Execution Context`,
      "function",
      functionScope,
      `Created whenever ${name} is called.`
    );

    if (node.body?.type === "BlockStatement") {
      walkStatements(node.body.body, functionScope, functionScope);
    } else {
      walkExpression(node.body, functionScope, functionScope);
    }

    return functionScope;
  }

  function recordHeapExpression(node, currentScope, hintName) {
    switch (node.type) {
      case "ObjectExpression": {
        const propertyNames = node.properties.map((property) => {
          if (property.type === "SpreadElement") {
            return "...spread";
          }
          return getPropertyName(property.key);
        });
        const heapRef = addHeap(
          hintName || "Object literal",
          "object",
          propertyNames.length ? `properties: ${propertyNames.join(", ")}` : "empty object",
          currentScope,
          node
        );
        node.properties.forEach((property) => {
          if (property.type === "SpreadElement") {
            walkExpression(property.argument, currentScope, currentScope);
          } else {
            walkExpression(property.value, currentScope, currentScope);
          }
        });
        return heapRef;
      }

      case "ArrayExpression": {
        const heapRef = addHeap(
          hintName || "Array literal",
          "array",
          `length: ${node.elements.length}`,
          currentScope,
          node
        );
        node.elements.forEach((element) => walkExpression(element, currentScope, currentScope));
        return heapRef;
      }

      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return handleFunctionExpression(node, currentScope, hintName);

      case "ClassExpression": {
        const className = node.id?.name || hintName || "AnonymousClass";
        const heapRef = addHeap(
          className,
          "class",
          `methods: ${node.body?.body?.length ?? 0}`,
          currentScope,
          node
        );
        walkClassBody(node, currentScope, className);
        return heapRef;
      }

      case "NewExpression": {
        const callee = getCalleeName(node.callee);
        const heapRef = addHeap(
          `${callee} instance`,
          "instance",
          `created with ${node.arguments.length} argument${node.arguments.length === 1 ? "" : "s"}`,
          currentScope,
          node
        );
        recordCall(`new ${callee}`, node, currentScope);
        node.arguments.forEach((argument) => walkExpression(argument, currentScope, currentScope));
        return heapRef;
      }

      default:
        return addHeap(hintName || node.type, "object", describeExpression(node), currentScope, node);
    }
  }

  function walkClassBody(node, currentScope, className) {
    node.body?.body?.forEach((method) => {
      if (method.value) {
        const methodName = getPropertyName(method.key);
        createFunctionScope(method.value, currentScope, `${className}.${methodName}`, "MethodDefinition");
      }
    });
  }

  function walkExpression(node, currentScope, functionScope) {
    if (!node) {
      return;
    }

    if (isHeapExpression(node)) {
      recordHeapExpression(node, currentScope, expressionHint(node));
      return;
    }

    switch (node.type) {
      case "CallExpression":
      case "OptionalCallExpression":
        recordCall(getCalleeName(node.callee), node, currentScope);
        walkExpression(node.callee, currentScope, functionScope);
        node.arguments?.forEach((argument) => walkExpression(argument, currentScope, functionScope));
        break;

      case "AssignmentExpression":
      case "AssignmentPattern":
        walkExpression(node.left, currentScope, functionScope);
        if (isHeapExpression(node.right)) {
          recordHeapExpression(node.right, currentScope, getAssignmentName(node.left));
        } else {
          walkExpression(node.right, currentScope, functionScope);
        }
        break;

      case "BinaryExpression":
      case "LogicalExpression":
        walkExpression(node.left, currentScope, functionScope);
        walkExpression(node.right, currentScope, functionScope);
        break;

      case "ConditionalExpression":
        walkExpression(node.test, currentScope, functionScope);
        walkExpression(node.consequent, currentScope, functionScope);
        walkExpression(node.alternate, currentScope, functionScope);
        break;

      case "MemberExpression":
      case "OptionalMemberExpression":
        walkExpression(node.object, currentScope, functionScope);
        if (node.computed) {
          walkExpression(node.property, currentScope, functionScope);
        }
        break;

      case "UnaryExpression":
      case "UpdateExpression":
      case "AwaitExpression":
      case "YieldExpression":
        walkExpression(node.argument, currentScope, functionScope);
        break;

      case "SequenceExpression":
        node.expressions.forEach((expression) => walkExpression(expression, currentScope, functionScope));
        break;

      case "TemplateLiteral":
        node.expressions.forEach((expression) => walkExpression(expression, currentScope, functionScope));
        break;

      case "TaggedTemplateExpression":
        walkExpression(node.tag, currentScope, functionScope);
        walkExpression(node.quasi, currentScope, functionScope);
        break;

      case "ChainExpression":
        walkExpression(node.expression, currentScope, functionScope);
        break;

      default:
        walkGenericNode(node, currentScope, functionScope);
    }
  }

  function walkGenericNode(node, currentScope, functionScope) {
    if (!node || typeof node !== "object") {
      return;
    }

    Object.entries(node).forEach(([key, value]) => {
      if (key === "type" || key === "loc" || key === "start" || key === "end") {
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((child) => {
          if (child?.type) {
            if (child.type.endsWith("Statement") || child.type.endsWith("Declaration")) {
              walkStatement(child, currentScope, functionScope);
            } else {
              walkExpression(child, currentScope, functionScope);
            }
          }
        });
      } else if (value?.type) {
        if (value.type.endsWith("Statement") || value.type.endsWith("Declaration")) {
          walkStatement(value, currentScope, functionScope);
        } else {
          walkExpression(value, currentScope, functionScope);
        }
      }
    });
  }

  function recordCall(label, node, currentScope) {
    const callLabel = label || "anonymous";
    const targetContext = findContextForCall(callLabel);
    const call = {
      label: callLabel,
      line: node?.loc?.start?.line ?? null,
      scopeName: currentScope.name,
      contextId: targetContext?.id || null,
    };

    model.calls.push(call);
    model.callStack.push(
      createFrame(
        `${callLabel}()`,
        targetContext ? "call" : "external",
        targetContext ? findScope(targetContext.scopeId) : currentScope,
        call.line,
        targetContext
      )
    );
  }
}

function finalizeModel(model) {
  model.scopes.forEach((scope) => {
    model.scopeChainsById.set(scope.id, buildScopeChain(model, scope));
  });
  model.memory = buildMemoryBindings(model);
}

function buildScopeChain(model, scope) {
  const chain = [];
  let current = scope;

  while (current) {
    chain.unshift(current);
    current = current.parentId ? model.scopesById.get(current.parentId) : null;
  }

  return chain;
}

function buildMemoryBindings(model) {
  const frameByContextId = new Map();
  const frameByHeapId = new Map();
  const heapIdsByFrameId = new Map();

  model.callStack.forEach((frame) => {
    if (frame.contextId) {
      frameByContextId.set(frame.contextId, frame);
    }
  });

  model.heap.forEach((heapItem) => {
    const frame = heapItem.contextId ? frameByContextId.get(heapItem.contextId) : null;

    if (!frame) {
      return;
    }

    frameByHeapId.set(heapItem.id, frame);

    if (!heapIdsByFrameId.has(frame.frameId)) {
      heapIdsByFrameId.set(frame.frameId, []);
    }

    heapIdsByFrameId.get(frame.frameId).push(heapItem.id);
  });

  return {
    frameByContextId,
    frameByHeapId,
    heapIdsByFrameId,
  };
}

function renderVariableEnvironment(model) {
  const lines = [];

  model.scopes.forEach((scope) => {
    const indent = "  ".repeat(scope.depth);
    lines.push(`${indent}${scope.name}`);

    if (!scope.declarations.length) {
      lines.push(`${indent}  no bindings detected`);
      return;
    }

    scope.declarations.forEach((declaration) => {
      const line = declaration.line ? ` @ line ${declaration.line}` : "";
      lines.push(
        `${indent}  ${declaration.kind} ${declaration.name} = ${declaration.value}${line}`
      );
    });
  });

  dom.variables.textContent = lines.join("\n");
}

function renderScopeChain(model) {
  dom.scopeChain.innerHTML = model.scopes
    .map((scope, index) => {
      const chain = getScopeChain(model, scope)
        .map((item) => item.name)
        .join(" -> ");
      const declarations = scope.declarations.length
        ? scope.declarations.map(renderBindingPill).join("")
        : `<span class="muted-chip">no local bindings</span>`;
      const outer = scope.parentId ? model.scopesById.get(scope.parentId)?.name : "none";

      return `
        <article class="scope-node scope-node--${escapeHtml(scope.type)}" style="--depth: ${scope.depth}; --delay: ${index};">
          <div class="scope-node__rail"></div>
          <div class="scope-node__content">
            <div class="scope-node__topline">
              <strong>${escapeHtml(scope.name)}</strong>
              <span>${escapeHtml(scope.type)}</span>
            </div>
            <p class="scope-chain-path">${escapeHtml(chain)}</p>
            <p class="scope-meta">Outer: ${escapeHtml(outer)}</p>
            <div class="binding-list">${declarations}</div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderExecutionContexts(model) {
  dom.executionContexts.innerHTML = model.contexts
    .map((context, index) => {
      const scope = model.scopesById.get(context.scopeId);
      const bindings = scope?.declarations.length
        ? scope.declarations.map(renderBindingPill).join("")
        : `<span class="muted-chip">empty lexical environment</span>`;
      const chain = scope
        ? getScopeChain(model, scope)
            .map((item) => item.name)
            .join(" -> ")
        : "unknown";

      return `
        <article class="context-card context-card--${escapeHtml(context.type)}" style="--delay: ${index};">
          <div class="context-card__header">
            <span class="context-id">${escapeHtml(context.id)}</span>
            <strong>${escapeHtml(context.name)}</strong>
          </div>
          <div class="context-metrics">
            <span>Scope: ${escapeHtml(context.scopeName)}</span>
            <span>Outer: ${escapeHtml(context.outer)}</span>
            <span>This: ${context.type === "global" ? "window/global object" : "runtime call receiver"}</span>
          </div>
          <p>${escapeHtml(context.reason)}</p>
          <p class="scope-chain-path">${escapeHtml(chain)}</p>
          <div class="binding-list">${bindings}</div>
        </article>
      `;
    })
    .join("");
}

function renderCallStack(model) {
  const frames = [...model.callStack].reverse();

  dom.callStack.innerHTML = frames
    .map((frame, index) => {
      const isTop = index === 0;
      const line = frame.line ? `line ${frame.line}` : "static frame";
      const boundHeapCount = getHeapBindingsForFrame(model, frame).length;
      const boundLabel = `${boundHeapCount} heap object${boundHeapCount === 1 ? "" : "s"}`;

      return `
        <div class="stack-frame stack-frame--${escapeHtml(frame.type)}" data-frame-id="${escapeHtml(frame.frameId)}" data-context-id="${escapeHtml(frame.contextId || "")}" style="--delay: ${index};">
          <span class="stack-frame__badge">${isTop ? "top" : frame.type}</span>
          <div class="stack-frame__content">
            <strong>${escapeHtml(frame.label)}</strong>
            <small>${escapeHtml(frame.scopeName)} - ${escapeHtml(line)}</small>
            <span class="binding-count">${escapeHtml(boundLabel)}</span>
          </div>
          <button class="stack-delete" type="button" aria-label="Delete ${escapeHtml(frame.label)} and its bound heap objects">
            <span aria-hidden="true">x</span>
          </button>
        </div>
      `;
    })
    .join("");

  scheduleBindingLayerRender();
}

function renderHeap(model) {
  if (!model.heap.length) {
    dom.heapMap.innerHTML = `<div class="empty-state">No heap allocations detected yet. Try object, array, class, function, or new expressions.</div>`;
    dom.bindingLayer.innerHTML = "";
    return;
  }

  dom.heapMap.innerHTML = model.heap
    .map((item, index) => {
      const line = item.line ? `line ${item.line}` : "static allocation";
      const boundFrame = getFrameForHeap(model, item);
      const bindingLabel = boundFrame
        ? `Bound to ${boundFrame.label}`
        : "Not currently bound to a visible stack frame";

      return `
        <article class="heap-object heap-object--${escapeHtml(item.type.replace(/\s+/g, "-"))}" data-heap-id="${escapeHtml(item.id)}" data-bound-frame-id="${escapeHtml(boundFrame?.frameId || "")}" data-context-id="${escapeHtml(item.contextId || "")}" style="--delay: ${index};">
          <div class="heap-object__header">
            <span>${escapeHtml(item.id)}</span>
            <strong>${escapeHtml(item.label)}</strong>
          </div>
          <p>${escapeHtml(item.details)}</p>
          <small>${escapeHtml(item.scopeName)} - ${escapeHtml(line)}</small>
          <span class="heap-binding">${escapeHtml(bindingLabel)}</span>
        </article>
      `;
    })
    .join("");

  scheduleBindingLayerRender();
}

function getFrameForHeap(model, heapItem) {
  return model.memory?.frameByHeapId.get(heapItem.id) || null;
}

function getHeapBindingsForFrame(model, frame) {
  const heapIds = model.memory?.heapIdsByFrameId.get(frame.frameId) || [];

  return heapIds;
}

function scheduleBindingLayerRender() {
  window.cancelAnimationFrame(pendingBindingRender);
  window.clearTimeout(pendingBindingRefresh);
  pendingBindingRender = window.requestAnimationFrame(() => {
    renderBindingLayer();
    pendingBindingRefresh = window.setTimeout(renderBindingLayer, 720);
  });
}

function renderBindingLayer() {
  const grid = dom.memoryGrid;
  const svg = dom.bindingLayer;

  if (!grid || !svg) {
    return;
  }

  const gridRect = grid.getBoundingClientRect();
  const heapObjects = [...dom.heapMap.querySelectorAll(".heap-object:not(.is-removing)")];
  const frameElementsById = new Map(
    [...dom.callStack.querySelectorAll(".stack-frame:not(.is-removing)")].map((frame) => [
      frame.dataset.frameId,
      frame,
    ])
  );
  const paths = [];

  heapObjects.forEach((heapObject, index) => {
    const frameId = heapObject.dataset.boundFrameId;

    if (!frameId) {
      return;
    }

    const stackFrame = frameElementsById.get(frameId);

    if (!stackFrame) {
      return;
    }

    const start = getArrowAnchor(stackFrame, gridRect, "stack");
    const end = getArrowAnchor(heapObject, gridRect, "heap");
    const pathData = createBindingPath(start, end);
    const heapId = heapObject.dataset.heapId || "";

    paths.push(`
      <path class="binding-arrow" data-bound-frame-id="${escapeHtml(frameId)}" data-heap-id="${escapeHtml(heapId)}" style="--delay: ${index};" d="${pathData}" marker-end="url(#binding-arrow-head)"></path>
      <circle class="binding-pulse" data-bound-frame-id="${escapeHtml(frameId)}" data-heap-id="${escapeHtml(heapId)}" style="--delay: ${index};">
        <animateMotion dur="2.4s" begin="${index * 0.14}s" repeatCount="indefinite" path="${pathData}" />
      </circle>
    `);
  });

  svg.setAttribute("viewBox", `0 0 ${gridRect.width} ${gridRect.height}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="binding-flow-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.35"></stop>
        <stop offset="52%" stop-color="var(--accent-3)" stop-opacity="1"></stop>
        <stop offset="100%" stop-color="var(--accent-2)" stop-opacity="0.9"></stop>
      </linearGradient>
      <marker id="binding-arrow-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" class="binding-arrow-head"></path>
      </marker>
    </defs>
    ${paths.join("")}
  `;
}

function getArrowAnchor(element, containerRect, role) {
  const rect = element.getBoundingClientRect();
  const isStack = role === "stack";

  return {
    x: (isStack ? rect.right : rect.left) - containerRect.left,
    y: rect.top + rect.height / 2 - containerRect.top,
    centerX: rect.left + rect.width / 2 - containerRect.left,
    top: rect.top - containerRect.top,
    bottom: rect.bottom - containerRect.top,
  };
}

function createBindingPath(start, end) {
  const horizontalGap = end.x - start.x;

  if (horizontalGap > 40) {
    const curve = Math.max(48, horizontalGap * 0.42);
    return `M ${start.x} ${start.y} C ${start.x + curve} ${start.y}, ${end.x - curve} ${end.y}, ${end.x} ${end.y}`;
  }

  const startX = start.centerX;
  const endX = end.centerX;
  const startY = start.bottom;
  const endY = end.top;
  const curve = Math.max(36, Math.abs(endY - startY) * 0.36);

  return `M ${startX} ${startY} C ${startX} ${startY + curve}, ${endX} ${endY - curve}, ${endX} ${endY}`;
}

function handleStackFrameDelete(event) {
  const button = event.target.closest(".stack-delete");

  if (!button) {
    return;
  }

  const frame = button.closest(".stack-frame");

  if (!frame) {
    return;
  }

  deleteStackFrame(frame);
}

function deleteStackFrame(frame) {
  const frameId = frame.dataset.frameId;
  const boundHeapObjects = [...dom.heapMap.querySelectorAll(`[data-bound-frame-id="${escapeCssIdentifier(frameId)}"]`)];
  const bindingShapes = [...dom.bindingLayer.querySelectorAll(`[data-bound-frame-id="${escapeCssIdentifier(frameId)}"]`)];

  frame.classList.add("is-removing");
  bindingShapes.forEach((shape) => shape.classList.add("is-removing"));
  boundHeapObjects.forEach((heapObject, index) => {
    heapObject.style.setProperty("--remove-delay", `${index * 70}ms`);
    heapObject.classList.add("is-removing");
  });

  window.setTimeout(renderBindingLayer, 360);

  window.setTimeout(() => {
    boundHeapObjects.forEach((heapObject) => heapObject.remove());
    frame.remove();
    updateBindingCountsFromDom();
    scheduleBindingLayerRender();

    if (!dom.callStack.querySelector(".stack-frame")) {
      dom.callStack.innerHTML = `<div class="empty-state">All execution contexts have been removed from the call stack.</div>`;
    }

    if (!dom.heapMap.querySelector(".heap-object") && !dom.heapMap.querySelector(".empty-state")) {
      dom.heapMap.innerHTML = `<div class="empty-state">All heap objects bound to removed contexts have been cleared.</div>`;
    }
  }, 620 + boundHeapObjects.length * 70);
}

function updateBindingCountsFromDom() {
  const frames = [...dom.callStack.querySelectorAll(".stack-frame")];

  frames.forEach((frame) => {
    const count = dom.heapMap.querySelectorAll(
      `.heap-object[data-bound-frame-id="${escapeCssIdentifier(frame.dataset.frameId)}"]`
    ).length;
    const label = `${count} heap object${count === 1 ? "" : "s"}`;
    const countElement = frame.querySelector(".binding-count");

    if (countElement) {
      countElement.textContent = label;
    }
  });
}

function renderBindingPill(declaration) {
  return `
    <span class="binding-pill binding-pill--${escapeHtml(declaration.kind)}" title="${escapeHtml(declaration.value)}">
      <b>${escapeHtml(declaration.kind)}</b> ${escapeHtml(declaration.name)}
    </span>
  `;
}

function getScopeChain(model, scope) {
  return model.scopeChainsById.get(scope.id) || buildScopeChain(model, scope);
}

function isHeapExpression(node) {
  return [
    "ObjectExpression",
    "ArrayExpression",
    "FunctionExpression",
    "ArrowFunctionExpression",
    "ClassExpression",
    "NewExpression",
  ].includes(node?.type);
}

function expressionHint(node) {
  if (!node) {
    return "value";
  }

  if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
    return node.id?.name || "anonymous function";
  }

  if (node.type === "ClassExpression") {
    return node.id?.name || "anonymous class";
  }

  if (node.type === "NewExpression") {
    return `${getCalleeName(node.callee)} instance`;
  }

  return node.type.replace("Expression", "").toLowerCase();
}

function describeExpression(node) {
  if (!node) {
    return "undefined";
  }

  switch (node.type) {
    case "Literal":
      return JSON.stringify(node.value);
    case "Identifier":
      return `lookup ${node.name}`;
    case "ObjectExpression":
      return "object literal";
    case "ArrayExpression":
      return `array literal (${node.elements.length})`;
    case "FunctionExpression":
      return `function ${node.id?.name || "anonymous"}()`;
    case "ArrowFunctionExpression":
      return "arrow function";
    case "ClassExpression":
      return `class ${node.id?.name || "anonymous"}`;
    case "NewExpression":
      return `new ${getCalleeName(node.callee)}()`;
    case "CallExpression":
    case "OptionalCallExpression":
      return `${getCalleeName(node.callee)}() result`;
    case "BinaryExpression":
    case "LogicalExpression":
      return `${describeExpression(node.left)} ${node.operator} ${describeExpression(node.right)}`;
    case "TemplateLiteral":
      return "template literal";
    case "UnaryExpression":
      return `${node.operator}${describeExpression(node.argument)}`;
    default:
      return node.type;
  }
}

function extractPatternNames(pattern) {
  if (!pattern) {
    return [];
  }

  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "RestElement":
      return extractPatternNames(pattern.argument);
    case "AssignmentPattern":
      return extractPatternNames(pattern.left);
    case "ArrayPattern":
      return pattern.elements.flatMap(extractPatternNames);
    case "ObjectPattern":
      return pattern.properties.flatMap((property) => {
        if (property.type === "RestElement") {
          return extractPatternNames(property.argument);
        }
        return extractPatternNames(property.value);
      });
    default:
      return [];
  }
}

function formatParams(params = []) {
  const names = params.flatMap(extractPatternNames);
  return names.length ? names.join(", ") : "none";
}

function getCalleeName(node) {
  if (!node) {
    return "anonymous";
  }

  switch (node.type) {
    case "Identifier":
      return node.name;
    case "MemberExpression":
    case "OptionalMemberExpression": {
      const object = getCalleeName(node.object);
      const property = node.computed
        ? describeExpression(node.property)
        : getPropertyName(node.property);
      return `${object}.${property}`;
    }
    case "Super":
      return "super";
    case "ThisExpression":
      return "this";
    case "CallExpression":
      return `${getCalleeName(node.callee)}()`;
    case "ChainExpression":
      return getCalleeName(node.expression);
    default:
      return node.type.replace("Expression", "");
  }
}

function getPropertyName(node) {
  if (!node) {
    return "unknown";
  }

  if (node.type === "Identifier" || node.type === "PrivateIdentifier") {
    return node.name;
  }

  if (node.type === "Literal") {
    return String(node.value);
  }

  return describeExpression(node);
}

function getAssignmentName(node) {
  if (!node) {
    return "assigned value";
  }

  if (node.type === "Identifier") {
    return node.name;
  }

  if (node.type === "MemberExpression") {
    return getCalleeName(node);
  }

  return "assigned value";
}

dom.code.addEventListener("input", scheduleCodeEditorSync);
dom.code.addEventListener("scroll", syncEditorScroll, PASSIVE_EVENT);
dom.code.addEventListener("keydown", handleEditorKeydown);
dom.output.addEventListener("scroll", syncOutputScroll, PASSIVE_EVENT);
dom.callStack.addEventListener("click", handleStackFrameDelete);
dom.callStack.addEventListener("scroll", scheduleBindingLayerRender, PASSIVE_EVENT);
dom.heapMap.addEventListener("scroll", scheduleBindingLayerRender, PASSIVE_EVENT);
window.addEventListener("resize", scheduleBindingLayerRender, PASSIVE_EVENT);
dom.runButton.addEventListener("click", runCode);
syncCodeEditor();
syncOutputLineNumbers("AST visualization here");
renderEmptyState("Paste JavaScript code and press Run to build the visual model.");
