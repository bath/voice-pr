export class FixtureDocument {
  constructor() {
    this.body = new FixtureElement("body");
    this.body.ownerDocument = this;
    this.pointElement = this.body;
    this.caretRange = null;
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }

  getElementById(id) {
    return this.querySelectorAll("[id]").find((node) => node.id === id) || null;
  }

  elementFromPoint() {
    return this.pointElement;
  }

  caretRangeFromPoint() {
    return this.caretRange;
  }
}

export class FixtureElement {
  constructor(tagName, attrs = {}, children = []) {
    this.nodeType = 1;
    this.tagName = tagName.toLowerCase();
    this.parentElement = null;
    this.ownerDocument = null;
    this.children = [];
    this.attributes = { ...attrs };
    this.id = attrs.id || "";
    this.textContent = "";
    this.rect = attrs.rect || { top: 0, bottom: 0 };
    this.classList = new Set(String(attrs.class || "").split(/\s+/).filter(Boolean));
    children.forEach((child) => this.appendChild(child));
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    this.#adopt(child, this.ownerDocument);
    this.#refreshText();
    return child;
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children || []) {
        if (child.nodeType === 1 && child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches?.(selector)) return node;
    }
    return null;
  }

  matches(selector) {
    return selector.split(",").some((part) => this.#matchesSingle(part.trim()));
  }

  getBoundingClientRect() {
    return this.rect;
  }

  #matchesSingle(selector) {
    if (!selector) return false;
    if (selector === "[id]") return Boolean(this.id);
    if (selector === "[data-tagsearch-path]") return this.attributes["data-tagsearch-path"] != null;
    if (selector === "[data-path]") return this.attributes["data-path"] != null;
    if (selector === "tr") return this.tagName === "tr";
    if (selector === ".file" || selector === ".js-file" || selector === ".file-header") {
      return this.classList.has(selector.slice(1));
    }
    if (selector === 'a[href^="#diff-"]') {
      return this.tagName === "a" && String(this.attributes.href || "").startsWith("#diff-");
    }
    if (selector === "td.blob-num[data-line-number]") {
      return this.tagName === "td" && this.classList.has("blob-num") && this.attributes["data-line-number"] != null;
    }
    if (selector === "td.blob-code") {
      return this.tagName === "td" && this.classList.has("blob-code");
    }
    return false;
  }

  #adopt(node, ownerDocument) {
    node.ownerDocument = ownerDocument;
    for (const child of node.children || []) this.#adopt(child, ownerDocument);
  }

  #refreshText() {
    this.textContent = this.children.map((child) => child.textContent || "").join("");
    this.parentElement?.#refreshText?.();
  }
}

export class FixtureText {
  constructor(textContent) {
    this.nodeType = 3;
    this.textContent = textContent;
    this.parentElement = null;
    this.ownerDocument = null;
  }
}

export function el(tagName, attrs, children) {
  return new FixtureElement(tagName, attrs, children);
}

export function text(textContent) {
  return new FixtureText(textContent);
}
