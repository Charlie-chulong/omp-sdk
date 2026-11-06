package main

import (
    "encoding/json"
    "fmt"
    "reflect"

    rpc "github.com/can1357/oh-my-pi/sdk/go/omp-rpc"
)

func main() {
    raw := []byte(`{"enabled":false,"default":{"mode":"proxy","url":"http://proxy.example:8080/"},"providers":{"anthropic":{"mode":"direct"}},"noProxy":["internal.example"]}`)
    var policy rpc.ProxyPolicy
    if err := json.Unmarshal(raw, &policy); err != nil { panic(err) }
    if policy.Enabled { panic("disabled policy was changed") }
    encoded, err := json.Marshal(policy)
    if err != nil { panic(err) }
    var expected, actual interface{}
    if err := json.Unmarshal(raw, &expected); err != nil { panic(err) }
    if err := json.Unmarshal(encoded, &actual); err != nil { panic(err) }
    if !reflect.DeepEqual(expected, actual) { panic("proxy policy fields did not round trip") }
    for _, invalid := range []string{
        `{"enabled":true,"default":{"mode":"ambient"}}`,
        `{"enabled":true,"default":{"mode":"proxy"}}`,
    } {
        if json.Unmarshal([]byte(invalid), &rpc.ProxyPolicy{}) == nil { panic("invalid proxy route was accepted") }
    }
    fmt.Println("PASS: Go generated proxy policy preserves disabled routing and rejects invalid modes/routes")
}
