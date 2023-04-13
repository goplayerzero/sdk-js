import replace from '@rollup/plugin-replace';
import typescript from '@rollup/plugin-typescript';
import nodeResolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

// eslint-disable-next-line no-undef
const version = process.env.npm_package_version

export default {
  input: 'src/index.ts',
  output: [
    { dir: './dist', format: 'esm', plugins: [terser()] },
  ],
  plugins: [
    typescript(),
    nodeResolve(),
    replace({ preventAssignment: true, __PlayerZeroSdkVersion__: version })
  ]
};
