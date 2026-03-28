/**
 * Xcode 16+ / toolchain Swift search paths from CocoaPods can break the simulator link step:
 * SwiftUICore.tbd "not an allowed client", missing swift_DarwinFoundation*, CoreAudioTypes, etc.
 * RN only removes swift-5.0; we also drop TOOLCHAIN swift paths and prefer $(SDKROOT)/usr/lib/swift.
 * Do not scrub the app/user Xcode project: overriding LIBRARY_SEARCH_PATHS without $(inherited) breaks -lEXConstants and other Pod libs.
 * @see https://github.com/CocoaPods/CocoaPods/issues/12672
 */
const { withPodfile, withXcodeProject } = require("expo/config-plugins");
const { mergeContents } = require("@expo/config-plugins/build/utils/generateCode");

module.exports = function withIosSwiftLinkerFix(config) {
  config = withPodfile(config, (cfg) => {
    const newSrc = [
      "    bad_swift_toolchain_tokens = [",
      "      '$(TOOLCHAIN_DIR)/usr/lib/swift/$(PLATFORM_NAME)',",
      '      "$(TOOLCHAIN_DIR)/usr/lib/swift/$(PLATFORM_NAME)",',
      '      \'"${TOOLCHAIN_DIR}/usr/lib/swift/${PLATFORM_NAME}"\',',
      "      '${TOOLCHAIN_DIR}/usr/lib/swift/${PLATFORM_NAME}',",
      "    ]",
      "    tnc_scrub_lib_search_paths = lambda do |paths|",
      "      next paths if paths.nil?",
      "      arr = paths.is_a?(Array) ? paths.flatten.map(&:to_s) : paths.to_s.split(/\\s+/).reject(&:empty?)",
      "      bad_swift_toolchain_tokens.each { |t| arr.delete(t) }",
      "      sdk_swift = '$(SDKROOT)/usr/lib/swift'",
      "      arr.unshift(sdk_swift) unless arr.any? { |p| p.include?('$(SDKROOT)/usr/lib/swift') }",
      "      arr.uniq",
      "    end",
      "    installer.pods_project.targets.each do |target|",
      "      target.build_configurations.each do |config|",
      "        config.build_settings['LIBRARY_SEARCH_PATHS'] = tnc_scrub_lib_search_paths.call(config.build_settings['LIBRARY_SEARCH_PATHS'])",
      "      end",
      "    end",
      "    installer.pods_project.save",
      "    support_root = File.join(installer.sandbox.root, 'Target Support Files')",
      "    Dir.glob(File.join(support_root, 'Pods-*', '*.xcconfig')).each do |xc_path|",
      "      body = File.read(xc_path)",
      "      next unless body.include?('LIBRARY_SEARCH_PATHS')",
      "      orig = body.dup",
      "      bad_swift_toolchain_tokens.each { |t| body.gsub!(/\\s*#{Regexp.escape(t)}\\s*/, ' ') }",
      "      unless body.include?('$(SDKROOT)/usr/lib/swift')",
      "        if body =~ /^LIBRARY_SEARCH_PATHS = \\$\\(inherited\\)/m",
      "          body.sub!(/^(LIBRARY_SEARCH_PATHS = \\$\\(inherited\\) )/m, '\\\\1$(SDKROOT)/usr/lib/swift ')",
      "        else",
      "          body.sub!(/^(LIBRARY_SEARCH_PATHS = )/m, '\\\\1$(SDKROOT)/usr/lib/swift ')",
      "        end",
      "      end",
      "      File.write(xc_path, body) if body != orig",
      "    end",
    ].join("\n");

    const { contents } = mergeContents({
      src: cfg.modResults.contents,
      newSrc,
      tag: "tnc-swift-linker-fix",
      anchor: /:ccache_enabled => ccache_enabled\?\(podfile_properties\),/,
      offset: 2,
      comment: "#",
    });

    cfg.modResults.contents = contents;
    return cfg;
  });

  return withXcodeProject(config, (cfg) => {
    if (cfg.modRequest.introspect) return cfg;
    const project = cfg.modResults;
    const projectName = cfg.modRequest.projectName;
    if (!projectName) return cfg;
    // Keep Swift SDK libs first, then CocoaPods paths from the xcconfig (EXConstants, etc.).
    project.updateBuildProperty(
      "LIBRARY_SEARCH_PATHS",
      ['"$(inherited)"', '"$(SDKROOT)/usr/lib/swift"'],
      null,
      projectName
    );
    return cfg;
  });
};
