declare namespace WebAssembly {
  interface ModuleImportDescriptor {
    module: string;
    name: string;
    kind: 'function' | 'table' | 'memory' | 'global' | 'tag';
  }
  interface ModuleExportDescriptor {
    name: string;
    kind: 'function' | 'table' | 'memory' | 'global' | 'tag';
  }
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class Module {
    constructor(bytes: Uint8Array<ArrayBuffer>);
    static imports(module: Module): ModuleImportDescriptor[];
    static exports(module: Module): ModuleExportDescriptor[];
  }
}
