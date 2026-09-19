class Sentinel < Formula
  include Language::Python::Virtualenv

  desc "Zero-overhead unified memory telemetry and runaway agent loop tripwire for Apple Silicon"
  homepage "https://github.com/Shlok04423/sentinel-ai"
  url "https://github.com/Shlok04423/sentinel-ai/archive/refs/tags/v1.0.1.tar.gz"
  sha256 "0019dfc4b32d63c1392aa264aed2253c1e0c2fb09216f8e2cc269bbfb8bb49b5"
  license "MIT"
  head "https://github.com/Shlok04423/sentinel-ai.git", branch: "main"

  depends_on "python@3.12"
  depends_on :macos

  def install
    virtualenv_install_with_resources
  end

  def caveats
    <<~EOS
      To manage the Sentinel-AI background daemon:
        sentinel-service install

      To run the menu bar companion:
        sentinel-bar &

      To start the telemetry server manually:
        sentinel
    EOS
  end

  test do
    assert_match "Sentinel-AI", shell_output("#{bin}/sentinel --help")
  end
end
