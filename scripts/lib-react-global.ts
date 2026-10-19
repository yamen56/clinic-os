/**
 * React as a global, for a script that renders the app's components under
 * tsx: they compile to React.createElement and expect it to be in scope.
 * Import this before them.
 */
import * as React from "react";

(globalThis as unknown as { React: typeof React }).React = React;
