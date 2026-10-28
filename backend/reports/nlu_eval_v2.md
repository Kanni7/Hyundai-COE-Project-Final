# V2 NLU evaluation (text only, synthetic data)

Hardware: Intel64 Family 6 Model 183 Stepping 1, GenuineIntel | 20 logical CPUs | 15.8 GiB RAM | Windows-10-10.0.26300-SP0 | Python 3.11.15

| model | set | n | accuracy | macro-F1 | decision acc | unsafe exec | correct-exec recall | negated blocked | unsupported rejected | ambiguous not executed |
|---|---|---|---|---|---|---|---|---|---|---|
| minilm_onnx_int8 | test | 538 | 0.697 | 0.700 | 0.513 | 13 (8.0%) | 0.434 | 10/10 | 44/60 | 52/54 |
| minilm_onnx_int8 | heldout_unseen | 141 | 0.731 | 0.738 | 0.674 | 3 (5.7%) | 0.575 | 10/10 | 11/13 | 7/7 |
| minilm_onnx_int8 | v1_mapped | 113 | 0.735 | 0.794 | 0.602 | 3 (8.3%) | 0.600 | 7/7 | 12/25 | 7/7 |
| minilm-ft_onnx_fp32 | test | 538 | 0.775 | 0.773 | 0.743 | 12 (4.9%) | 0.678 | 10/10 | 48/60 | 54/54 |
| minilm-ft_onnx_fp32 | heldout_unseen | 141 | 0.837 | 0.840 | 0.721 | 2 (3.2%) | 0.690 | 10/10 | 7/13 | 7/7 |
| minilm-ft_onnx_fp32 | v1_mapped | 113 | 0.841 | 0.899 | 0.735 | 1 (2.3%) | 0.782 | 7/7 | 13/25 | 7/7 |
| minilm-ft_onnx_int8 | test | 538 | 0.768 | 0.764 | 0.734 | 17 (6.9%) | 0.661 | 10/10 | 50/60 | 53/54 |
| minilm-ft_onnx_int8 | heldout_unseen | 141 | 0.808 | 0.811 | 0.698 | 5 (8.1%) | 0.655 | 10/10 | 7/13 | 7/7 |
| minilm-ft_onnx_int8 | v1_mapped | 113 | 0.805 | 0.862 | 0.726 | 4 (8.5%) | 0.782 | 7/7 | 13/25 | 7/7 |

| baseline | set | accuracy | macro-F1 |
|---|---|---|---|
| keyword_rules | test | 0.461 | 0.515 |
| tfidf_char_logreg | test | 0.705 | 0.706 |
| keyword_rules | heldout_unseen | 0.624 | 0.661 |
| tfidf_char_logreg | heldout_unseen | 0.745 | 0.766 |
| keyword_rules | v1_mapped | 0.681 | 0.717 |
| tfidf_char_logreg | v1_mapped | 0.681 | 0.726 |

Latency (single utterance, encoder + heads, 2 threads):

- minilm_onnx_int8: median 3.86 ms, p95 4.64 ms
- minilm-ft_onnx_fp32: median 7.34 ms, p95 8.83 ms
- minilm-ft_onnx_int8: median 3.6 ms, p95 4.39 ms

Parameter extraction (gold intent): {"temperature": {"n": 38, "accuracy": 0.9474}, "destination": {"n": 36, "exact_match_normalised": 0.6667}, "amount_heldout": {"n": 18, "accuracy": 0.8889}}
