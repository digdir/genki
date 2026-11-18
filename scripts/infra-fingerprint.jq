def refs($x; $kind): [$x | tojson | scan("\($kind)\\('([^']+)'\\)")[0]] | unique;

def picked($object; $names): ($object // {}) | with_entries(select(.key == "copy" or (.key | IN($names[]))));

def used($template; $seed):
  def grow:
    [$seed, picked($template.variables; .v), picked($template.parameters; .p)] as $reach
    | {p: refs($reach; "parameters"), v: refs($reach; "variables")};
  {p: [], v: []} | until(. == grow; grow);

def apps_module: .type == "Microsoft.Resources/deployments" and .name == "containerapps";

def apps_interface:
  .properties.template as $inner
  | [
      ($inner.resources // [])[]
      | select(.type == "Microsoft.App/containerApps")
      | {name, copy, ingress: .properties.configuration.ingress}
    ] as $ingress
  | used($inner; [$inner.outputs, $ingress]) as $u
  | {
      name, type, condition, dependsOn,
      parameters: picked(.properties.parameters; $u.p),
      template: {
        outputs: $inner.outputs,
        ingress: $ingress,
        variables: picked($inner.variables; $u.v),
        parameters: picked($inner.parameters; $u.p)
      }
    };

(.templateJson | fromjson) as $template
| (.parametersJson | fromjson | .parameters) as $values
| [$template.resources[] | if apps_module then apps_interface else . end] as $resources
| [$resources[] | if .template.outputs then del(.template) else del(.properties.template) end] as $seed
| used($template; $seed) as $u
| {
    parameters: picked($values; $u.p),
    template: (
      $template
      | del(.outputs)
      | .resources = $resources
      | .variables = picked($template.variables; $u.v)
      | .parameters = picked($template.parameters; $u.p)
    )
  }
| walk(if type == "object" then del(._generator) else . end)
