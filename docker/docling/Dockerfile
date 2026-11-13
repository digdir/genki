# The Docling server for PDF conversions (ADR 0042, issue 476): docling-serve's CPU image, with its models baked in,
# plus Tesseract's Norwegian data, which the image does not have. Both pinned: the image by digest, the data by
# checksum. docling-serve 1.38.2 runs Docling 2.142.1 (docling-slim), docling-core 2.104.0, docling-ibm-models 4.0.4;
# the version is part of each conversion's key, so an upgrade here converts files again only when they have no
# kept conversion. The settings it runs with are set in infra/modules/containerapps.bicep.
FROM ghcr.io/docling-project/docling-serve-cpu:v1.38.2@sha256:7a480a1604fa3b42efeddc7db9527690d9f9bc903226136013e2bfe6b1a4dfb0
# tessdata 4.1.0, the same data as Debian's tesseract-ocr-nor, which the parser benchmark ran (docling-tess).
ADD --checksum=sha256:b859e4de24d2d23900d993d74819d33339255414057b5098dad2819a1894aa22 --chmod=644 https://github.com/tesseract-ocr/tessdata/raw/4.1.0/nor.traineddata /usr/share/tesseract/tessdata/nor.traineddata
