/**
 * TalkingHead loads optional language modules with import(moduleName). Next's
 * bundlers cannot statically resolve that expression. This app disables those
 * modules and supplies Azure/Oculus visemes directly, so make the unused path
 * harmless while keeping the rest of the library untouched.
 */
module.exports = function talkingHeadLoader(source) {
  return source
    .replaceAll("import(moduleName)", "Promise.resolve(null)")
    // Avatar loading starts the animation loop before the user has interacted.
    // Animation does not require audio, and the app resumes audio synchronously
    // from its Send/microphone handlers, so avoid Chrome's autoplay warning here.
    .replace(
      "if ( this.armature && this.isRunning === false ) {\n      this.audioCtx.resume();",
      "if ( this.armature && this.isRunning === false ) {",
    );
};
