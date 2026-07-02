// Error taxonomy — the conformance suite (SPEC.md / agape-conformance README) asserts an error
// *class*, not a message. We carry the class on `cls`; an implementation may use its own internal
// names but must map to these categories. Front-end errors (LexError/ParseError) live in lexer/parser.
//
// Static (compile) classes: TypeError, ColorViolation, ExhaustivenessError, ConfigError,
//   ModuleError, VisibilityError, InterfaceError, GateError.
// Dynamic (runtime) kernel classes: TaintViolation, AuthorityViolation.

export class AgapeError extends Error {
  constructor(public readonly cls: string, message: string) {
    super(message);
    this.name = cls;
  }
}

export const typeError = (m: string) => new AgapeError("TypeError", m);
export const colorViolation = (m: string) => new AgapeError("ColorViolation", m);
export const taintViolation = (m: string) => new AgapeError("TaintViolation", m);
export const authorityViolation = (m: string) => new AgapeError("AuthorityViolation", m);
export const exhaustivenessError = (m: string) => new AgapeError("ExhaustivenessError", m);
export const configError = (m: string) => new AgapeError("ConfigError", m);
export const gateError = (m: string) => new AgapeError("GateError", m);
// Library-layer conformance classes (§19). InterfaceError: a `agent : Iface` that fails nominal
// conformance (missing handler, mismatched decided outcome, or a `requires cap` the agent lacks).
// VisibilityError: a `pub` signature exposing a private surface (a `pub` interface/struct/fn/agent
// whose event/outcome/field/param/return type or required capability names a module-private decl).
export const interfaceError = (m: string) => new AgapeError("InterfaceError", m);
export const visibilityError = (m: string) => new AgapeError("VisibilityError", m);
export const moduleError = (m: string) => new AgapeError("ModuleError", m);
