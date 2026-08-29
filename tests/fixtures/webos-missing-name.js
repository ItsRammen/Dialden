/* Fixture for the client static check: mirrors the shape of the two bugs that
   reached the TV -- a helper referenced after its declaration was removed. */
(function () {
  'use strict';
  function useIt() {
    return neverDeclared(1);
  }
  window.fixtureUseIt = useIt;
}());
