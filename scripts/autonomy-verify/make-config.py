# Regenerates agent-config.json from the project's real config/agent.yaml (needs PyYAML).
import yaml, json, pathlib
here = pathlib.Path(__file__).resolve().parent
json.dump(yaml.safe_load((here / "../../config/agent.yaml").read_text()), open(here / "agent-config.json", "w"), indent=1)
print("agent-config.json regenerated")
