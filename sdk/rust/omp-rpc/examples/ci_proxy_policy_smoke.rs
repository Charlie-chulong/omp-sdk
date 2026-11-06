use omp_rpc::ProxyPolicy;
use serde_json::json;

fn main() {
    let expected = json!({
        "enabled": false,
        "default": {"mode": "proxy", "url": "http://proxy.example:8080/"},
        "providers": {"anthropic": {"mode": "direct"}},
        "noProxy": ["internal.example"]
    });
    let policy: ProxyPolicy = serde_json::from_value(expected.clone()).expect("decode proxy policy");
    assert!(!policy.enabled);
    assert_eq!(serde_json::to_value(&policy).expect("encode proxy policy"), expected);
    for invalid in [
        json!({"enabled": true, "default": {"mode": "ambient"}}),
        json!({"enabled": true, "default": {"mode": "proxy"}}),
    ] {
        assert!(serde_json::from_value::<ProxyPolicy>(invalid).is_err());
    }
    println!("PASS: Rust generated proxy policy preserves disabled routing and rejects invalid modes/routes");
}
