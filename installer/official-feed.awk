# Read the three scalar fields in electron-builder's official update feed.
# Accept inline and folded YAML scalars; never evaluate YAML as shell code.
/^[^[:space:]#][^:]*:/ {
  key=$0; sub(/:.*/, "", key)
  if (key != "version" && key != "path" && key != "sha512") { pending=""; next }
  if (seen[key]++) exit 2
  value=$0; sub(/^[^:]+:[[:space:]]*/, "", value)
  if (value == ">-" || value == "|-" || value == ">" || value == "|") { pending=key; next }
  values[key]=value; pending=""; next
}
pending && /^[[:space:]]+[^[:space:]]/ { value=$0; sub(/^[[:space:]]+/, "", value); values[pending]=value; pending="" }
END {
  if (!values["version"] || !values["path"] || !values["sha512"]) exit 2
  print values["version"]; print values["path"]; print values["sha512"]
}
