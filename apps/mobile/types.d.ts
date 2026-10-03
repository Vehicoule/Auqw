/// <reference types="expo/types" />

// Cross-package sources (ui-native) import PNG assets; expo/types does
// not declare image modules, so the ambient decl lives here where this
// program sees it.
declare module '*.png' {
  import type { ImageSourcePropType } from 'react-native';
  const source: ImageSourcePropType;
  export default source;
}
