(require '[digdir.rag.chunking :as chunking]
         '[digdir.docs.pipeline.core :as core]
         '[cheshire.core :as json]
         '[clojure.string :as str])

(def root (first *command-line-args*))
(def corpus (json/parse-string (slurp (str root "/corpus.json")) true))

(defn kw-value [v]
  (if (and (map? v) (:kw v)) (keyword (:kw v)) v))

(defn config-map [m]
  (into {} (map (fn [[k v]] [(keyword (subs (str k) 1)) (kw-value v)])) m))

(defn header-based [kview printer text]
  (->> (chunking/split-into-chunks-by-headers kview [{:page-content text}])
       (mapv (fn [{:keys [page-content metadata]}]
               {:content_markdown page-content
                :metadata ((if (= printer "prn") prn-str pr-str) metadata)}))))

(defn fixed-width [{:keys [width overlap]} text]
  (mapv (fn [c] {:content_markdown (str/join c)}) (partition-all width (- width overlap) text)))

(defn chunk-case [c]
  (let [text (slurp (str root "/" (:file c)))
        doc-num (case (:docNum c)
                  "LOC" (core/sha256-short-hash (:location c))
                  "PATH" (core/sha256-short-hash (:location c))
                  (:docNum c))
        kview (cond-> {:chunks/minimum-length (:minimumLength c)}
                (:splitMaxLength c) (assoc :chunks/split-max-length (:splitMaxLength c))
                (:overlap c) (assoc :chunks/overlap (:overlap c)))
        raw (case (:strategy c)
              "header-based" (header-based kview (:printer c) text)
              "fixed-width" (fixed-width c text))
        kept (filter #(let [l (count (:content_markdown %))]
                        (and (>= l (:minimumLength c)) (<= l (:maximumLength c))))
                     raw)]
    {:id (:id c)
     :docNum doc-num
     :chunks (->> kept
                  (core/assign-chunk-ids doc-num)
                  (map-indexed (fn [i ch]
                                 (cond-> (assoc ch :doc_num doc-num :chunk_index i
                                                :content_length (count (:content_markdown ch)))
                                   (:location c) (assoc :location (:location c)))))
                  vec)}))

(def chunk-results (mapv chunk-case (:chunking corpus)))

(def phrase-result
  (let [chunks (:chunks (first (filter #(= (:id %) (get-in corpus [:phrases :case])) chunk-results)))
        per (get-in corpus [:phrases :perChunk])
        doc-num (:docNum (first (filter #(= (:id %) (get-in corpus [:phrases :case])) chunk-results)))
        pairs (map vector chunks (concat per (repeat [])))]
    {:legacy (vec (for [[c ps] pairs, p ps]
                    {:id (core/sha256-short-hash (str (:chunk_id c) "|" p)) :search_phrase p
                     :chunk_id (:chunk_id c) :doc_num doc-num}))
     :pipeline (vec (for [[c ps] pairs, p ps
                          :when (and p (string? p) (not (str/blank? p)))]
                      {:id (core/sha256-short-hash (str (:chunk_id c) "|" p)) :search_phrase p
                       :chunk_id (:chunk_id c) :doc_num doc-num}))}))

(def parser-results
  (try
    (require 'digdir.docs.pipeline.search-phrases)
    (let [parse (resolve 'digdir.docs.pipeline.search-phrases/parse-phrases-response)]
      (mapv (fn [content] {:content content
                           :phrases (parse {:choices [{:message {:content content}}]})})
            (:parser corpus)))
    (catch Throwable e {:error (str e)})))

(defn extract-ns [m ns]
  (into {} (filter (fn [[k _]] (let [n (namespace k)]
                                 (and n (or (str/starts-with? n (str ns ".")) (= ns n))))))
        m))

(def collections
  (let [{:keys [legacyKudosPrefix pipeline pipelineNames]} (:collections corpus)
        pconf (config-map (:config pipeline))
        nconf (config-map (:config pipelineNames))
        empty-hash (core/sha256-short-hash (select-keys [:hash-changer :strategy] {}))]
    {:legacyKudos [(str legacyKudosPrefix "documents_" empty-hash)
                   (str legacyKudosPrefix "chunks_" empty-hash)
                   (str legacyKudosPrefix "phrases_" empty-hash)]
     :pipeline [(str (:prefix pipeline) "documents_" (core/sha256-short-hash (extract-ns pconf "documents")))
                (str (:prefix pipeline) "chunks_" (core/sha256-short-hash (extract-ns pconf "chunks")))
                (str (:prefix pipeline) "phrases_" (core/sha256-short-hash (extract-ns pconf "search-phrases")))]
     :pipelineNames (let [h (core/sha256-short-hash
                             (select-keys nconf [:source-type :chunk-strategy :chunk-minimum-length
                                                 :chunk-maximum-length :search-phrases-model
                                                 :search-phrases-fallback :search-phrases-prompt]))
                          prefix (:collection-prefix nconf)]
                      [(str prefix "documents_" h) (str prefix "chunks_" h) (str prefix "phrases_" h)])}))

(spit (str root "/expected.json")
      (json/generate-string {:generatedBy "headless-rag digdir.rag.chunking and digdir.docs.pipeline.core"
                             :chunking chunk-results
                             :phrases phrase-result
                             :parser parser-results
                             :collections collections}
                            {:pretty true}))
(println "wrote" (str root "/expected.json"))
(shutdown-agents)
